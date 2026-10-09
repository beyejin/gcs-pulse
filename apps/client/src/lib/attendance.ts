import { api } from './api';

export type AttendanceSession = {
  id: number;
  title: string;
  is_open: boolean;
  access_token: string;
  created_at: string;
  closed_at: string | null;
};

export type AttendanceDetail = AttendanceSession & {
  records: { user_id: number; name: string; email: string; checked_in_at: string }[];
};

export type CheckInResult = {
  title: string;
  name: string;
  checked_in_at: string;
  duplicate: boolean;
};

export const attendanceApi = {
  list: () => api.get<{ items: AttendanceSession[] }>('/attendance/sessions'),
  create: (title: string) => api.post<AttendanceSession>('/attendance/sessions', { title }),
  detail: (id: number, signal?: AbortSignal) =>
    api.get<AttendanceDetail>(`/attendance/sessions/${id}`, { signal }),
  close: (id: number) => api.post<AttendanceSession>(`/attendance/sessions/${id}/close`),
  checkIn: (token: string) =>
    api.post<CheckInResult>(`/attendance/checkin/${encodeURIComponent(token)}`),
};

export function attendanceTime(value: string) {
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value));
}
