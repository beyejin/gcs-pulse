"""Authenticated QR attendance. Identity always comes from the existing session."""

import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, update

from app.database import AsyncSessionLocal
from app.dependencies import get_active_user, require_professor_or_admin_role, verify_csrf
from app.limiter import limiter, auth_me_rate_limit_key
from app.models import AttendanceRecord, AttendanceSession, User

router = APIRouter(prefix="/attendance", tags=["attendance"], dependencies=[Depends(verify_csrf)])


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def nonblank_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("수업명을 입력해 주세요.")
        return value.strip()


def utc(value: datetime | None) -> datetime | None:
    # SQLite drops timezone information from DateTime(timezone=True).
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def session_payload(session: AttendanceSession) -> dict:
    return {
        "id": session.id, "title": session.title, "is_open": session.is_open,
        "access_token": session.access_token, "created_at": utc(session.created_at),
        "closed_at": utc(session.closed_at),
    }


async def managed_session(db, session_id: int, user: User) -> AttendanceSession:
    require_professor_or_admin_role(user)
    session = await db.get(AttendanceSession, session_id)
    if session is None:
        raise HTTPException(404, "출석 세션을 찾을 수 없습니다.")
    if session.owner_user_id != user.id and "admin" not in user.roles:
        raise HTTPException(403, "본인이 만든 출석부만 관리할 수 있습니다.")
    return session


@router.get("/sessions")
@limiter.limit("60/minute", key_func=auth_me_rate_limit_key)
async def list_sessions(request: Request, user: User = Depends(get_active_user)):
    require_professor_or_admin_role(user)
    async with AsyncSessionLocal() as db:
        query = select(AttendanceSession).order_by(AttendanceSession.id.desc()).limit(100)
        if "admin" not in user.roles:
            query = query.where(AttendanceSession.owner_user_id == user.id)
        sessions = (await db.scalars(query)).all()
        return {"items": [session_payload(session) for session in sessions]}


@router.post("/sessions", status_code=201)
@limiter.limit("20/minute", key_func=auth_me_rate_limit_key)
async def create_session(request: Request, payload: SessionCreate, user: User = Depends(get_active_user)):
    require_professor_or_admin_role(user)
    async with AsyncSessionLocal() as db:
        session = AttendanceSession(title=payload.title, owner_user_id=user.id, access_token=secrets.token_urlsafe(32))
        db.add(session)
        await db.commit()
        await db.refresh(session)
        return session_payload(session)


@router.get("/sessions/{session_id}")
@limiter.limit("120/minute", key_func=auth_me_rate_limit_key)
async def session_detail(request: Request, session_id: int, user: User = Depends(get_active_user)):
    async with AsyncSessionLocal() as db:
        session = await managed_session(db, session_id, user)
        rows = (await db.execute(
            select(AttendanceRecord, User.name, User.email)
            .join(User, User.id == AttendanceRecord.user_id)
            .where(AttendanceRecord.session_id == session.id)
            .order_by(AttendanceRecord.checked_in_at, AttendanceRecord.id)
        )).all()
        return {**session_payload(session), "records": [
            {"user_id": record.user_id, "name": name or email, "email": email,
             "checked_in_at": utc(record.checked_in_at)}
            for record, name, email in rows
        ]}


@router.post("/sessions/{session_id}/close")
@limiter.limit("20/minute", key_func=auth_me_rate_limit_key)
async def close_session(request: Request, session_id: int, user: User = Depends(get_active_user)):
    async with AsyncSessionLocal() as db:
        await managed_session(db, session_id, user)
        await db.execute(update(AttendanceSession).where(
            AttendanceSession.id == session_id, AttendanceSession.is_open.is_(True),
        ).values(is_open=False, closed_at=datetime.now(timezone.utc)))
        await db.commit()
        session = await db.get(AttendanceSession, session_id, populate_existing=True)
        return session_payload(session)


@router.post("/checkin/{token}")
@limiter.limit("60/minute", key_func=auth_me_rate_limit_key)
async def check_in(request: Request, token: str, user: User = Depends(get_active_user)):
    async with AsyncSessionLocal() as db:
        # A no-op update locks the session on both PostgreSQL and SQLite. It
        # serializes duplicate check-ins and closure without a process-local lock.
        session = (await db.execute(update(AttendanceSession)
            .where(AttendanceSession.access_token == token)
            .values(is_open=AttendanceSession.is_open)
            .returning(AttendanceSession))).scalar_one_or_none()
        if session is None:
            raise HTTPException(404, "유효하지 않은 QR입니다. 현재 수업의 QR을 다시 찍어 주세요.")
        record = await db.scalar(select(AttendanceRecord).where(
            AttendanceRecord.session_id == session.id, AttendanceRecord.user_id == user.id,
        ))
        duplicate = record is not None
        if not record:
            if not session.is_open:
                raise HTTPException(409, "출석이 마감되었습니다. 운영자에게 문의해 주세요.")
            record = AttendanceRecord(session_id=session.id, user_id=user.id)
            db.add(record)
            await db.flush()
        result = {"title": session.title, "name": user.name or user.email,
                  "checked_in_at": utc(record.checked_in_at), "duplicate": duplicate}
        await db.commit()
        return result
