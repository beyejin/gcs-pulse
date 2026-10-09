import type { Metadata } from 'next';
import CheckInPageClient from './page.client';

export const metadata: Metadata = {
  title: '출석 확인 | GCS Pulse',
  robots: { index: false, follow: false },
};

export default async function CheckInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <CheckInPageClient token={token} />;
}
