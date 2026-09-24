import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, JSON, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class UserSession(Base):
    __tablename__ = "user_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class Recording(Base):
    __tablename__ = "recordings"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    language: Mapped[str | None] = mapped_column(String(16), nullable=True)
    title: Mapped[str | None] = mapped_column(String(240), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="recording", index=True)
    audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    audio_mime_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    audio_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    transcript_original: Mapped[str] = mapped_column(Text, default="")
    transcript_edited: Mapped[str | None] = mapped_column(Text, nullable=True)
    whisper_model: Mapped[str] = mapped_column(String(80), default="whisper-1")
    processing_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    is_favourite: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    draft_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    recovery_dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    chunks: Mapped[list["TranscriptionChunk"]] = relationship(back_populates="recording", cascade="all, delete-orphan")
    revisions: Mapped[list["TranscriptRevision"]] = relationship(back_populates="recording", cascade="all, delete-orphan")
    events: Mapped[list["UsageEvent"]] = relationship(back_populates="recording", cascade="all, delete-orphan")
    audio_segments: Mapped[list["RecordingAudioSegment"]] = relationship(back_populates="recording", cascade="all, delete-orphan")

    @property
    def transcript(self) -> str:
        return self.transcript_edited if self.transcript_edited is not None else self.transcript_original



class RecordingAudioSegment(Base):
    __tablename__ = "recording_audio_segments"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recording_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recordings.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    audio_mime_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    audio_size: Mapped[int | None] = mapped_column(Integer, nullable=True)

    recording: Mapped[Recording] = relationship(back_populates="audio_segments")


class TranscriptionChunk(Base):
    __tablename__ = "transcription_chunks"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recording_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recordings.id", ondelete="CASCADE"), index=True)
    chunk_number: Mapped[int] = mapped_column(Integer)
    started_at_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ended_at_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    edited_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    processing_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    recording: Mapped[Recording] = relationship(back_populates="chunks")


class TranscriptRevision(Base):
    __tablename__ = "transcript_revisions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recording_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recordings.id", ondelete="CASCADE"), index=True)
    previous_text: Mapped[str] = mapped_column(Text)
    new_text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    recording: Mapped[Recording] = relationship(back_populates="revisions")


class UsageEvent(Base):
    __tablename__ = "usage_events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recording_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("recordings.id", ondelete="CASCADE"), nullable=True, index=True)
    event_type: Mapped[str] = mapped_column(String(40), index=True)
    event_data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)

    recording: Mapped[Recording | None] = relationship(back_populates="events")


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)



class SpeakerProfile(Base):
    __tablename__ = "speaker_profiles"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(120), index=True)
    embedding: Mapped[list] = mapped_column(JSON)
    sample_count: Mapped[int] = mapped_column(Integer, default=1)
    source_recording_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("recordings.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class SpeakerProfileSample(Base):
    __tablename__ = "speaker_profile_samples"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("speaker_profiles.id", ondelete="CASCADE"), index=True
    )
    embedding: Mapped[list] = mapped_column(JSON)
    source_recording_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("recordings.id", ondelete="SET NULL"), nullable=True, index=True
    )
    source_analysis_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("speaker_analyses.id", ondelete="SET NULL"), nullable=True, index=True
    )
    source_detection_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("speaker_detections.id", ondelete="SET NULL"), nullable=True, index=True
    )
    speech_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class SpeakerAnalysis(Base):
    __tablename__ = "speaker_analyses"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    recording_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recordings.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    model: Mapped[str] = mapped_column(String(200), default="")
    speaker_count: Mapped[int] = mapped_column(Integer, default=0)
    processing_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SpeakerDetection(Base):
    __tablename__ = "speaker_detections"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    analysis_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("speaker_analyses.id", ondelete="CASCADE"), index=True)
    speaker_key: Mapped[str] = mapped_column(String(80))
    person_index: Mapped[int] = mapped_column(Integer)
    display_name: Mapped[str] = mapped_column(String(120))
    embedding: Mapped[list] = mapped_column(JSON)
    profile_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("speaker_profiles.id", ondelete="SET NULL"), nullable=True, index=True
    )
    match_score: Mapped[float | None] = mapped_column(Float, nullable=True)


class SpeakerTurn(Base):
    __tablename__ = "speaker_turns"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    analysis_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("speaker_analyses.id", ondelete="CASCADE"), index=True)
    detection_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("speaker_detections.id", ondelete="CASCADE"), index=True)
    start_seconds: Mapped[float] = mapped_column(Float)
    end_seconds: Mapped[float] = mapped_column(Float)
    text: Mapped[str] = mapped_column(Text, default="")
