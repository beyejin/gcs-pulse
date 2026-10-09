'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import QRCode, { type QRCodeProps } from 'react-qr-code';
import { Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@/context/auth-context';
import {
  attendanceApi,
  attendanceTime,
  type AttendanceSession,
  type AttendanceDetail,
} from '@/lib/attendance';

// Match the existing QR component's React type compatibility handling.
const AttendanceQRCode = QRCode as unknown as ComponentType<QRCodeProps>;

export default function AttendancePageClient() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const canManage = Boolean(user?.roles.some((role) => role === '교수' || role === 'admin'));
  const [sessions, setSessions] = useState<AttendanceSession[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<AttendanceDetail | null>(null);
  const [title, setTitle] = useState('');
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    if (!isLoading && !isAuthenticated) router.replace('/login?next=%2Fprofessor%2Fattendance');
  }, [isLoading, isAuthenticated, router]);

  useEffect(() => {
    if (!canManage) return;
    let disposed = false;
    attendanceApi
      .list()
      .then(({ items }) => {
        if (disposed) return;
        setSessions(items);
        setSelected((current) => current ?? items[0]?.id ?? null);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [canManage]);

  useEffect(() => {
    if (!canManage || selected === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setDetail(null);
    setUpdated('');
    setCopied(false);
    const refresh = async () => {
      try {
        const result = await attendanceApi.detail(selected, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(result);
        setSessions((items) => items.map((item) => (item.id === result.id ? result : item)));
        setUpdated(new Date().toISOString());
        setError('');
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '출석부를 불러오지 못했습니다.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selected, canManage]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await attendanceApi.create(title.trim());
      setSessions((items) => [session, ...items]);
      setSelected(session.id);
      setTitle('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '출석을 시작하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const session = await attendanceApi.close(detail.id);
      setDetail((current) => (current?.id === session.id ? { ...current, ...session } : current));
      setSessions((items) => items.map((item) => (item.id === session.id ? session : item)));
    } catch (e) {
      setError(e instanceof Error ? e.message : '마감하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading)
    return (
      <main className="p-8">
        <Loader2 className="animate-spin" aria-label="로그인 확인 중" />
      </main>
    );
  if (!isAuthenticated) return null;
  if (!canManage)
    return (
      <main className="mx-auto max-w-3xl p-8">
        <PageHeader
          title="출석 관리 권한이 필요합니다"
          description="교수 또는 관리자 계정으로 이용해 주세요. 학생은 수업 QR을 스캔해 출석할 수 있습니다."
        />
      </main>
    );

  const link = detail && origin ? `${origin}/attendance/checkin/${detail.access_token}` : '';
  return (
    <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
      <PageHeader
        title="QR 출석"
        description="학생은 QR을 열면 로그인 계정으로 자동 출석합니다. 출석부는 3초마다 갱신됩니다."
      />
      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <section className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="attendance-title">수업명</Label>
          <Input
            id="attendance-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="예: 창업 프로젝트 6주차"
            required
            maxLength={120}
            disabled={busy}
          />
        </section>
        <Button disabled={busy || !title.trim()} type="submit">
          새 출석 시작
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error} 마지막으로 받은 명단일 수 있습니다.
        </p>
      )}
      <section className="space-y-2">
        <Label htmlFor="attendance-session">출석부 선택</Label>
        <select
          id="attendance-session"
          className="w-full rounded-md border border-input bg-background p-3 text-sm"
          value={selected ?? ''}
          disabled={busy}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          <option value="" disabled>
            수업을 시작해 주세요
          </option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title} ({session.is_open ? '진행 중' : '마감'})
            </option>
          ))}
        </select>
      </section>
      {detail ? (
        <section className="grid items-start gap-6 lg:grid-cols-[360px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>{detail.title}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {detail.is_open ? '출석 진행 중' : '출석 마감'}
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              {detail.is_open && link ? (
                <figure
                  className="mx-auto w-fit max-w-full rounded-xl p-4 [&_svg]:h-auto [&_svg]:max-w-full"
                  style={{ background: '#ffffff' }}
                >
                  <AttendanceQRCode
                    value={link}
                    size={240}
                    fgColor="#000000"
                    bgColor="#ffffff"
                    title={`${detail.title} 출석 QR`}
                  />
                </figure>
              ) : (
                <p className="py-12 text-center text-muted-foreground">출석이 마감되었습니다.</p>
              )}
              <p className="text-sm text-muted-foreground">
                시작 {attendanceTime(detail.created_at)}
              </p>
              {detail.is_open && (
                <>
                  <Button asChild variant="outline" className="w-full">
                    <a href={link} target="_blank" rel="noopener noreferrer">
                      학생 출석 화면 열기
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(link);
                        setCopied(true);
                      } catch {
                        setError(
                          '링크 복사를 지원하지 않는 브라우저입니다. 학생 화면의 주소를 복사해 주세요.',
                        );
                      }
                    }}
                  >
                    {copied ? '링크 복사 완료' : '학생 링크 복사'}
                  </Button>
                  <Button className="w-full" disabled={busy} onClick={close}>
                    출석 마감
                  </Button>
                </>
              )}
              <p className="text-xs text-muted-foreground">
                QR 공유를 통한 원격 출석까지 확인하는 기능은 포함하지 않습니다.
              </p>
            </CardContent>
          </Card>
          <section className="space-y-4" aria-live="polite">
            <h2 className="text-xl font-semibold">
              출석 명단 <span className="text-primary">{detail.records.length}명</span>
            </h2>
            <p className="text-xs text-muted-foreground">
              {updated ? `마지막 갱신 ${attendanceTime(updated)}` : '불러오는 중'}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>학생</TableHead>
                  <TableHead>계정</TableHead>
                  <TableHead>출석 시각</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.records.map((record) => (
                  <TableRow key={record.user_id}>
                    <TableCell className="font-medium">{record.name}</TableCell>
                    <TableCell>{record.email}</TableCell>
                    <TableCell>{attendanceTime(record.checked_in_at)}</TableCell>
                  </TableRow>
                ))}
                {detail.records.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-12 text-center text-muted-foreground">
                      아직 출석한 학생이 없습니다. QR을 보여 주세요.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </section>
        </section>
      ) : (
        <p className="py-12 text-center text-muted-foreground">
          {selected ? '출석부를 불러오는 중입니다.' : '수업명을 입력하고 첫 출석을 시작해 보세요.'}
        </p>
      )}
    </main>
  );
}
