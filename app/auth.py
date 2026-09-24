import base64
import hashlib
import hmac
import re
import secrets
import uuid
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .db import get_db
from .models import Recording, User, UserSession


router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_NAME = "talk_to_type_session"
PBKDF2_ITERATIONS = 600_000
_current_user_id: ContextVar[uuid.UUID | None] = ContextVar("current_user_id", default=None)
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{2,80}$")


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


def normalize_username(value: str) -> str:
    username = (value or "").strip().lower()
    if not USERNAME_RE.fullmatch(username):
        raise ValueError("Username must use letters, numbers, dot, dash or underscore.")
    return username


def hash_password(password: str) -> str:
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters.")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    return (
        "pbkdf2_sha256$"
        + str(PBKDF2_ITERATIONS)
        + "$"
        + base64.urlsafe_b64encode(salt).decode("ascii").rstrip("=")
        + "$"
        + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    )


def _decode_b64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds, salt_text, digest_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = _decode_b64(salt_text)
        expected = _decode_b64(digest_text)
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            int(rounds),
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def session_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def user_payload(user: User) -> dict:
    return {
        "id": str(user.id),
        "username": user.username,
        "display_name": user.display_name,
        "is_admin": bool(user.is_admin),
    }


async def ensure_default_user(db: AsyncSession) -> User:
    username = normalize_username(settings.default_username)
    password = settings.default_password
    if len(password) < 8:
        raise RuntimeError("DEFAULT_PASSWORD must be at least 8 characters.")

    user = (
        await db.execute(select(User).where(User.username == username))
    ).scalar_one_or_none()
    if not user:
        user = User(
            username=username,
            display_name=(settings.default_display_name.strip() or username),
            password_hash=hash_password(password),
            is_active=True,
            is_admin=True,
        )
        db.add(user)
        await db.flush()

    admin_count = await db.scalar(select(func.count()).select_from(User).where(User.is_admin.is_(True)))
    if not admin_count:
        user.is_admin = True

    orphaned = (
        await db.execute(select(Recording).where(Recording.user_id.is_(None)))
    ).scalars().all()
    for recording in orphaned:
        recording.user_id = user.id

    await db.commit()
    await db.refresh(user)
    return user


async def user_from_request(request: Request, db: AsyncSession) -> User | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None

    now = datetime.now(timezone.utc)
    token_hash = session_token_hash(token)
    session = (
        await db.execute(
            select(UserSession).where(
                UserSession.token_hash == token_hash,
                UserSession.expires_at > now,
            )
        )
    ).scalar_one_or_none()
    if not session:
        return None

    user = await db.get(User, session.user_id)
    if not user or not user.is_active:
        return None
    return user


async def optional_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User | None:
    return await user_from_request(request, db)


def set_current_user_id(user_id: uuid.UUID):
    return _current_user_id.set(user_id)


def reset_current_user_id(token) -> None:
    _current_user_id.reset(token)


def current_user_id() -> uuid.UUID:
    user_id = _current_user_id.get()
    if user_id is None:
        raise RuntimeError("No authenticated user in request context.")
    return user_id


async def require_user(user: User | None = Depends(optional_user)) -> User:
    if not user:
        raise HTTPException(status_code=401, detail="Login required")
    return user


async def require_admin(user: User = Depends(require_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


@router.post("/login")
async def login(
    payload: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        username = normalize_username(payload.username)
    except ValueError:
        raise HTTPException(status_code=401, detail="Incorrect username or password")

    user = (
        await db.execute(select(User).where(User.username == username))
    ).scalar_one_or_none()
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        if not user:
            hashlib.pbkdf2_hmac(
                "sha256",
                payload.password.encode("utf-8"),
                b"local-transcriber",
                50_000,
            )
        raise HTTPException(status_code=401, detail="Incorrect username or password")

    now = datetime.now(timezone.utc)
    await db.execute(delete(UserSession).where(UserSession.expires_at <= now))

    token = secrets.token_urlsafe(40)
    expires = now + timedelta(days=settings.auth_session_days)
    db.add(
        UserSession(
            user_id=user.id,
            token_hash=session_token_hash(token),
            expires_at=expires,
        )
    )
    await db.commit()

    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=settings.auth_session_days * 24 * 60 * 60,
        expires=expires,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
        path="/",
    )
    return {"user": user_payload(user)}


@router.post("/logout", status_code=204)
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> Response:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        await db.execute(
            delete(UserSession).where(UserSession.token_hash == session_token_hash(token))
        )
        await db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")
    response.status_code = 204
    return response


@router.get("/me")
async def me(user: User = Depends(require_user)) -> dict:
    return {"user": user_payload(user)}
