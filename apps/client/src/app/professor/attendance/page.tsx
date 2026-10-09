import type { Metadata } from 'next';
import AttendancePageClient from './page.client';

export const metadata: Metadata = { title: 'QR 출석 | GCS Pulse' };

export default function AttendancePage() {
  return <AttendancePageClient />;
}
