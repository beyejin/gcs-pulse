'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/context/auth-context';
import { attendanceApi, attendanceTime, type CheckInResult } from '@/lib/attendance';

export default function CheckInPageClient({ token }: { token: string }) {
  const { user, isLoading, isAuthenticated, authError } = useAuth();
  const router = useRouter();
  const [outcome, setOutcome] = useState<{
    token: string;
    email?: string;
    result?: CheckInResult;
    error?: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const email = user?.email;
  const current = outcome?.token === token && outcome?.email === email ? outcome : null;
  const result = current?.result;
  const error = current?.error;

  useEffect(() => {
    if (isLoading || authError) return;
    if (!isAuthenticated) {
      router.replace(`/login?next=${encodeURIComponent(`/attendance/checkin/${token}`)}`);
      return;
    }
    let disposed = false;
    attendanceApi
      .checkIn(token)
      .then((data) => {
        if (!disposed) setOutcome({ token, email, result: data });
      })
      .catch((e) => {
        if (!disposed)
          setOutcome({
            token,
            email,
            error: e instanceof Error ? e.message : '출석하지 못했습니다. 다시 시도해 주세요.',
          });
      });
    return () => {
      disposed = true;
    };
  }, [isLoading, isAuthenticated, authError, email, token, attempt, router]);

  const message = authError || error;
  return (
    <main className="mx-auto max-w-lg px-6 py-12">
      <Card>
        <CardHeader className="items-center text-center">
          {result ? (
            <CheckCircle2 className="h-12 w-12 text-primary" aria-hidden />
          ) : (
            !message && (
              <Loader2 className="h-10 w-10 animate-spin text-primary" aria-label="출석 확인 중" />
            )
          )}
          <CardTitle>
            {result
              ? result.duplicate
                ? '이미 출석했어요'
                : '출석 완료'
              : message
                ? '출석을 확인해 주세요'
                : '출석을 확인하고 있어요'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-center" aria-live="polite">
          {result && (
            <>
              <p>{result.name}님의 출석을 기록했습니다.</p>
              <dl className="space-y-4 text-sm">
                <dt className="text-muted-foreground">수업</dt>
                <dd className="font-semibold">{result.title}</dd>
                <dt className="text-muted-foreground">출석 시각</dt>
                <dd>{attendanceTime(result.checked_in_at)}</dd>
              </dl>
              <p className="text-sm text-muted-foreground">
                {result.duplicate
                  ? '여러 번 접속해도 최초 출석 한 건만 집계됩니다.'
                  : '출석부에 반영되었습니다. 이 화면을 닫아도 됩니다.'}
              </p>
            </>
          )}
          {message && (
            <>
              <p role="alert" className="text-sm text-destructive">
                {message}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  if (authError) window.location.reload();
                  else {
                    setOutcome(null);
                    setAttempt((value) => value + 1);
                  }
                }}
              >
                다시 확인
              </Button>
            </>
          )}
          {!result && !message && (
            <p className="text-sm text-muted-foreground">로그인된 GCS 계정으로 자동 처리합니다.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
