# 로그인 계정으로 QR 출석하기

교수 또는 관리자가 수업 QR을 보여 주면, 학생이 링크를 열었을 때 기존 GCS 로그인 계정으로 출석합니다. 학생 이름을 고르는 화면은 없습니다. 현재 단계는 포크에서 검증하는 초기 구현이며 공식 서비스 배포는 별도 검토 대상입니다.

## 사용 흐름

1. 교수 또는 관리자는 상단 출석 메뉴 또는 `/professor/attendance`에 접속합니다.
2. 수업명을 입력하고 새 출석 시작을 누릅니다.
3. 학생에게 QR을 보여 줍니다. QR에는 해당 수업의 임의 토큰을 담은 `/attendance/checkin/{token}` 주소가 들어갑니다.
4. 로그인된 학생은 자동 출석합니다. 로그인이 필요하면 기존 로그인 화면으로 이동하며 로그인 후 원래 출석 페이지로 돌아옵니다.
5. 운영자 명단은 3초마다 새로 받아 출석 인원과 시각을 표시합니다.
6. 출석 마감 후에는 새로운 출석을 받지 않습니다. 이미 출석한 학생은 최초 출석 기록을 다시 확인할 수 있습니다.

생성자는 자신의 출석부만 관리하며 관리자는 전체 출석부에 접근할 수 있습니다. 학생은 운영자 명단에 접근할 수 없습니다. 최근 100개 출석부를 선택해서 조회합니다. 수강생 명단을 아직 연결하지 않았으므로 미출석 인원이나 출석률은 계산하지 않습니다.

## 데이터와 인증

`attendance_sessions`는 수업명, 생성자, QR 토큰, 시작과 마감 상태를 저장합니다. `attendance_records`는 수업 ID, 로그인 사용자 ID와 최초 출석 시각을 저장합니다. 서버를 재시작해도 DB 기록은 유지됩니다.

사용자 ID는 기존 `get_active_user` 인증 결과에서만 가져옵니다. 클라이언트가 전달하는 이름이나 사용자 ID로 출석 대상을 바꾸지 않습니다. 기존 역할 및 필수 약관 확인과 CSRF 검증을 적용합니다.

수업과 사용자 조합의 DB 유일 제약으로 중복을 방지합니다. 출석 처리 시 수업 행을 잠가 동시 스캔과 마감이 순서대로 처리되도록 합니다. SQLite와 PostgreSQL에서 사용할 수 있는 UPDATE 잠금 방식이며 시제품 검증은 SQLite에서 수행했습니다. PostgreSQL 실제 동시성 검증은 운영 반영 전 필요합니다.

QR은 현장에 있는지 증명하지 않습니다. 링크를 다른 사람에게 전달하면 원격에서도 로그인 후 출석할 수 있습니다. 위치 인증, QR 주기 변경, 지각 판정, 수강생 배정, 출석 수정과 내보내기는 이번 범위에 포함하지 않았습니다.

## 실행과 마이그레이션

루트 README의 환경 설치 절차를 따르고 별도 개발 DB를 사용합니다. 기존 마이그레이션 명령으로 두 테이블과 출석 라우트 권한 메타데이터 5개를 생성합니다.

```sh
cd apps/server
PYTHONPATH=. python scripts/migrate_and_seed.py
PYTHONPATH=. python -m uvicorn app.main:app --host 127.0.0.1 --port 8018
```

클라이언트의 `.env.local`에는 `NEXT_PUBLIC_API_URL=http://localhost:8018`을 지정합니다. 서버의 `AUTH_SUCCESS_URL`과 `CORS_ORIGINS`에는 사용하는 클라이언트 주소를 지정합니다. 아래 포트를 사용한다면 `http://localhost:3018`입니다.

```sh
npm run dev --workspace apps/client -- --port 3018 --hostname 127.0.0.1
```

로컬 검증은 별도 SQLite DB의 가상 교수 및 학생 계정으로 기존 간편 입장을 사용했습니다. 실제 GCS 쿠키나 운영 DB 자격 증명은 사용하지 않았으며 인증 우회 기능도 추가하지 않았습니다. 개발 DB에는 시연 계정의 역할과 약관 동의 상태를 준비해야 합니다. 실제 Google OAuth 검증에는 해당 환경에 허용된 OAuth 클라이언트와 콜백 주소가 필요합니다. 포크했다고 운영 사이트의 로그인 세션이 localhost와 공유되지는 않습니다.

휴대폰에서 시험하려면 로컬호스트 대신 휴대폰이 접근 가능한 개발 호스트를 사용해야 합니다. 프런트엔드, API 주소, CORS, 호스트 허용 목록과 서버 바인딩을 함께 맞춥니다. 실제 배포는 HTTPS를 사용합니다.

## 검증

2026년 10월 9일 검증 기준입니다.

1. 출석 API 및 DB 경계 테스트 8개 통과: 기존 로그인 식별, CSRF, 역할, 소유권, 필수 약관, 잘못된 QR, 중복 요청 12건, 같은 Wi-Fi의 계정별 요청 제한, 마감 경쟁, 수업별 분리, UTC 시각.
2. 기존 인증, CSRF, 회의실 및 요청 제한 관련 테스트 51개 통과.
3. TypeScript 검사, 변경 파일 ESLint와 클라이언트 프로덕션 빌드 통과.
4. 서로 다른 브라우저의 교수와 학생 계정으로 로그인 복귀, 자동 출석, 명단 갱신을 확인. 서버 재시작 후 기록 보존과 다음 수업의 재로그인 없는 자동 출석도 확인.
5. 전체 클라이언트 lint는 기존 토너먼트 화면 오류 3개와 경고 12개로 실패. 이 변경에서 해당 파일은 수정하지 않았습니다.

```sh
cd apps/server
ENVIRONMENT=test TEST_DATABASE_URL=sqlite+aiosqlite:///:memory: PYTHONPATH=. python -m pytest tests/test_attendance_endpoints.py tests/test_db_session_static_guards.py tests/test_auth_terms_tokens_endpoints.py tests/test_csrf_dependency.py tests/test_meeting_rooms_endpoints.py tests/test_rate_limit_regression.py -q
```

다음 단계는 교수님께 이 흐름을 시연하고 수업별 대상 학생과 출석 운영 규칙을 확인하는 것입니다. 포크 내 검증은 계속할 수 있으며 공식 GCS 반영은 담당자 검토와 환경 설정 확인 후 진행합니다.
