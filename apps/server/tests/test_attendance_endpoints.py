"""Exercise the real auth/CSRF dependencies and database through HTTP."""

import asyncio
import base64
import json

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from itsdangerous import TimestampSigner
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.middleware.sessions import SessionMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app import dependencies
from app.database import Base
from app.limiter import limiter
from app.models import AttendanceRecord, AttendanceSession, User, Term
from app.routers import attendance

TEST_SECRET = "attendance-test-secret-only"


def session_headers(email="student@example.test", csrf=True):
    payload = base64.b64encode(json.dumps({"user": {"email": email}, "csrf_token": "test-csrf"}).encode())
    token = TimestampSigner(TEST_SECRET).sign(payload).decode()
    return {"Cookie": f"session={token}", **({"X-CSRF-Token": "test-csrf"} if csrf else {})}


@pytest_asyncio.fixture
async def service(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/attendance.db")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with factory() as db:
        db.add_all([
            User(id=1, email="professor@example.test", name="가상 교수", roles=["교수"]),
            User(id=2, email="student@example.test", name="가상 학생", roles=["gcs"]),
            User(id=3, email="other@example.test", name="다른 교수", roles=["교수"]),
            User(id=4, email="second@example.test", name="두 번째 학생", roles=["gcs"]),
            User(id=5, email="admin@example.test", name="가상 관리자", roles=["admin"]),
            User(id=6, email="visitor@example.test", name="권한 없는 사용자", roles=["user"]),
        ])
        await db.commit()
    monkeypatch.setattr(attendance, "AsyncSessionLocal", factory)
    monkeypatch.setattr(dependencies, "AsyncSessionLocal", factory)
    monkeypatch.setattr(limiter, "enabled", False)
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.add_middleware(SessionMiddleware, secret_key=TEST_SECRET)
    app.include_router(attendance.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client, factory
    await engine.dispose()


@pytest.mark.asyncio
async def test_shared_wifi_does_not_share_student_rate_limit(service, monkeypatch):
    client, _ = service
    monkeypatch.setattr(limiter, "enabled", True)
    limiter.reset()
    session = await create(client)
    path = f"/attendance/checkin/{session['access_token']}"
    for _ in range(60):
        assert (await client.post(path, headers=session_headers())).status_code == 200
    assert (await client.post(path, headers=session_headers())).status_code == 429
    assert (await client.post(path, headers=session_headers("second@example.test"))).status_code == 200
    limiter.reset()


async def create(client, title="출석 테스트"):
    response = await client.post("/attendance/sessions", json={"title": title}, headers=session_headers("professor@example.test"))
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.asyncio
async def test_authenticated_identity_duplicates_and_persistence(service):
    client, factory = service
    session = await create(client)
    path = f"/attendance/checkin/{session['access_token']}"
    response = await client.post(path, json={"user_id": 4, "name": "다른 사람"}, headers=session_headers())
    assert response.status_code == 200
    assert response.json()["name"] == "가상 학생"
    assert response.json()["duplicate"] is False
    assert response.json()["checked_in_at"].endswith("Z") or response.json()["checked_in_at"].endswith("+00:00")
    again = await client.post(path, headers=session_headers())
    assert again.json()["duplicate"] is True
    assert again.json()["checked_in_at"] == response.json()["checked_in_at"]
    # A fresh database session sees one durable record with the authenticated ID.
    async with factory() as db:
        records = (await db.scalars(select(AttendanceRecord))).all()
        assert len(records) == 1
        assert records[0].user_id == 2
    detail = await client.get(f"/attendance/sessions/{session['id']}", headers=session_headers("professor@example.test"))
    assert detail.json()["records"][0]["name"] == "가상 학생"


@pytest.mark.asyncio
async def test_auth_csrf_roles_and_owner_boundaries(service):
    client, _ = service
    assert (await client.get("/attendance/sessions")).status_code == 401
    assert (await client.post("/attendance/sessions", json={"title": "test"}, headers=session_headers())).status_code == 403
    assert (await client.post("/attendance/sessions", json={"title": "test"}, headers=session_headers("professor@example.test", csrf=False))).status_code == 403
    session = await create(client)
    detail = f"/attendance/sessions/{session['id']}"
    for email in ["student@example.test", "other@example.test"]:
        assert (await client.get(detail, headers=session_headers(email))).status_code == 403
        assert (await client.post(detail + "/close", headers=session_headers(email))).status_code == 403
    assert (await client.get("/attendance/sessions", headers=session_headers("other@example.test"))).json()["items"] == []
    assert (await client.get(detail, headers=session_headers("admin@example.test"))).status_code == 200
    path = f"/attendance/checkin/{session['access_token']}"
    assert (await client.post(path, headers=session_headers(csrf=False))).status_code == 403
    assert (await client.post(path, headers=session_headers("visitor@example.test"))).status_code == 403
    assert (await client.post(path, headers={"X-CSRF-Token": "test-csrf"})).status_code in (401, 403)


@pytest.mark.asyncio
async def test_closed_invalid_qr_and_new_session(service):
    client, _ = service
    session = await create(client)
    path = f"/attendance/checkin/{session['access_token']}"
    await client.post(path, headers=session_headers())
    closed = await client.post(f"/attendance/sessions/{session['id']}/close", headers=session_headers("professor@example.test"))
    assert closed.json()["is_open"] is False
    assert closed.json()["closed_at"]
    assert (await client.post(path, headers=session_headers("second@example.test"))).status_code == 409
    assert (await client.post(path, headers=session_headers())).json()["duplicate"] is True
    assert (await client.post("/attendance/checkin/invalid", headers=session_headers())).status_code == 404
    next_session = await create(client, "다음 수업")
    assert next_session["access_token"] != session["access_token"]
    assert (await client.post(f"/attendance/checkin/{next_session['access_token']}", headers=session_headers())).json()["duplicate"] is False


@pytest.mark.asyncio
async def test_concurrent_scans_and_closure(service):
    client, factory = service
    session = await create(client)
    path = f"/attendance/checkin/{session['access_token']}"
    results = await asyncio.gather(*[client.post(path, headers=session_headers()) for _ in range(12)])
    assert all(result.status_code == 200 for result in results)
    assert sum(not result.json()["duplicate"] for result in results) == 1
    assert len({result.json()["checked_in_at"] for result in results}) == 1
    await asyncio.gather(
        client.post(path, headers=session_headers("second@example.test")),
        client.post(f"/attendance/sessions/{session['id']}/close", headers=session_headers("professor@example.test")),
    )
    async with factory() as db:
        closed = await db.get(AttendanceSession, session["id"])
        records = (await db.scalars(select(AttendanceRecord))).all()
        assert closed.is_open is False
        assert all(record.checked_in_at <= closed.closed_at for record in records)


@pytest.mark.asyncio
async def test_validation_and_required_consents(service):
    client, factory = service
    professor = session_headers("professor@example.test")
    for title in [" ", "", "x" * 121]:
        assert (await client.post("/attendance/sessions", json={"title": title}, headers=professor)).status_code == 422
    assert (await client.post("/attendance/sessions", json={"title": "test", "owner_user_id": 4}, headers=professor)).status_code == 422
    session = await create(client)
    async with factory() as db:
        db.add(Term(type="test", version="1", content="test", is_active=True, is_required=True))
        await db.commit()
    response = await client.post(f"/attendance/checkin/{session['access_token']}", headers=session_headers())
    assert response.status_code == 403
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AttendanceRecord)) == 0
