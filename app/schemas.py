import uuid
from datetime import datetime

from pydantic import BaseModel, Field
from typing import Literal


class RecordingCreate(BaseModel):
    language: str | None = None
    title: str | None = None


class RecordingFinish(BaseModel):
    transcript: str = ""
    duration_seconds: float | None = Field(default=None, ge=0)
    processing_seconds: float = Field(default=0, ge=0)
    append: bool = False


class RecordingDraftUpdate(BaseModel):
    text: str = ""
    active_capture: bool = False


class RecordingUpdate(BaseModel):
    title: str | None = None
    transcript_edited: str | None = None
    is_favourite: bool | None = None


class RecordingOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    finished_at: datetime | None
    last_activity_at: datetime
    duration_seconds: float | None
    language: str | None
    title: str | None
    status: str
    transcript_original: str
    transcript_edited: str | None
    transcript: str
    is_favourite: bool
    has_audio: bool
    word_count: int
    draft_text: str | None = None


class SpeakerTurnUpdate(BaseModel):
    text: str = Field(max_length=20000)


class SpeakerIdentityUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    target_profile_id: uuid.UUID | None = None
    target_detection_id: uuid.UUID | None = None
    unknown: bool = False
    clear: bool = False
    scope: Literal["turn", "detection"] = "turn"


class SpeechRequest(BaseModel):
    input: str
    recording_id: uuid.UUID | None = None
    voice: str | None = None
    speed: float = Field(default=0.9, ge=0.25, le=4.0)


class EventCreate(BaseModel):
    event_type: str
    recording_id: uuid.UUID | None = None
    event_data: dict = Field(default_factory=dict)
