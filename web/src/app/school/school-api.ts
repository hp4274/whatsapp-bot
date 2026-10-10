/**
 * Typed client for /api/school. This file is the wire contract between the
 * school portal and server/src/school/routes.js - change both together.
 *
 * Class key: `${className}${section}`, e.g. "10A". Parent contacts are tagged
 * `class-10a`, `route-<busRoute>` and `hostel` so broadcasts resolve by tag.
 */

import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

export type StaffTitle = 'principal' | 'class_teacher' | 'accounts' | 'front_desk';
export type SchoolArea =
  | 'overview'
  | 'attendance'
  | 'timetable'
  | 'homework'
  | 'notices'
  | 'students'
  | 'fees'
  | 'leave'
  | 'results'
  | 'broadcast'
  | 'ptm'
  | 'staff'
  | 'settings';
export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';
export type Day = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';
export type NoticeKind = 'circular' | 'holiday' | 'event' | 'exam';
export type BroadcastKind = 'emergency' | 'bus' | 'general';

/** Who gets a broadcast. Exactly one key is set. */
export type Audience = { all: true } | { classKeys: string[] } | { routes: string[] };

export interface SchoolSettings {
  schoolName: string;
  gateCutoff: string; // 'HH:MM' - arrivals after this are late
  homeworkSendTime: string; // 'HH:MM' - default scheduled homework time
  absentAlertTime: string | null; // 'HH:MM' auto-send absent alerts daily, null = manual only
  monthlySummary: boolean; // auto-send attendance summary on the 1st
  commandsEnabled: boolean; // ATTENDANCE / TIMETABLE / ... WhatsApp keywords
  upiId: string;
  payeeName: string;
  currency: string;
}

export interface SchoolMe {
  title: StaffTitle;
  classes: string[]; // empty = all classes
  areas: SchoolArea[]; // what this user may open
}

export interface Overview {
  date: string;
  students: number;
  classes: number;
  attendance: { marked: number; present: number; absent: number; late: number; rate: number };
  alerts: { absentSent: number; absentTotal: number };
  inbox: { unread: number };
  fees: { month: string; collected: number; pending: number; overdue: number; currency: string };
  leave: { pending: number };
  homeworkToday: number;
}

export interface ClassInfo {
  key: string;
  className: string;
  section: string;
  students: number;
}

export interface Student {
  id: number;
  rollNumber: string;
  name: string;
  className: string;
  section: string;
  classKey: string;
  fatherName: string;
  motherName: string;
  parentPhone: string;
  busRoute: string;
  hostel: boolean;
  status: string;
  contactId: number | null;
}

export interface ImportResult {
  imported: number;
  updated: number;
  errors: { row: number; error: string }[];
}
export interface SendResult {
  sent: number;
  skipped: number;
  failed: number;
}

export interface AttendanceRow {
  studentId: number;
  rollNumber: string;
  name: string;
  status: AttendanceStatus | null;
  arrivedAt: string | null;
  alertedAt: string | null;
}
export interface AttendanceSheet {
  date: string;
  classKey: string;
  rows: AttendanceRow[];
}
export interface StudentAttendance {
  student: Student;
  month: string;
  days: { date: string; status: AttendanceStatus }[];
  percentage: number;
  absentDates: string[];
}

export interface TimetableEntry {
  id?: number;
  day: Day;
  period: string;
  startTime: string;
  endTime: string;
  subject: string;
  teacher: string;
  room: string;
  status?: 'scheduled' | 'changed' | 'cancelled';
}

export interface Homework {
  id: number;
  classKey: string;
  subject: string;
  title: string;
  instructions: string;
  dueAt: string | null;
  mediaId: string | null;
  sendAt: string | null;
  status: string;
  createdAt: string;
}

export interface Notice {
  id: number;
  kind: NoticeKind;
  title: string;
  body: string;
  startsAt: string | null;
  endsAt: string | null;
  audience: Audience;
  mediaId: string | null;
  sentAt: string | null;
  status: string;
  createdAt: string;
}

export interface Fee {
  id: number;
  studentId: number;
  studentName: string;
  classKey: string;
  term: string;
  amount: number;
  currency: string;
  dueAt: string;
  paidAt: string | null;
  method: string | null;
  payLink: string | null;
  receiptNo: string | null;
  status: 'pending' | 'paid' | 'overdue' | 'waived';
}
export interface FeeTotals {
  collected: number;
  pending: number;
  overdue: number;
  currency: string;
}

export interface ExamResult {
  id: number;
  studentId: number;
  rollNumber: string;
  studentName: string;
  classKey: string;
  examName: string;
  breakdown: { subject: string; marks: number; total: number }[];
  marks: number;
  totalMarks: number;
  grade: string;
  dispatchedAt: string | null;
}

export interface LeaveRequest {
  ticketId: number;
  reference: string;
  studentName: string;
  classKey: string;
  parentPhone: string;
  reason: string;
  fromDate: string | null;
  toDate: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export interface PtmSlot {
  id: number;
  startsAt: string;
  durationMinutes: number;
  teacher: string;
  classKey: string;
  status: 'open' | 'booked' | 'cancelled';
  studentName: string | null;
  parentPhone: string | null;
}

export interface StaffMember {
  id: number;
  email: string;
  name: string;
  role: string;
  title: StaffTitle;
  classes: string[];
}

/**
 * Thin HTTP wrapper over /api/school. Every method returns a cold Observable
 * that completes after one response, so callers need no teardown.
 */
@Injectable({ providedIn: 'root' })
export class SchoolApi {
  private readonly http = inject(HttpClient);

  private get<T>(
    path: string,
    query: Record<string, string | number | undefined | null> = {},
  ): Observable<T> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== null && v !== '') params = params.set(k, v);
    return this.http.get<T>(`/api/school${path}`, { params }).pipe(catchError(toMessage));
  }
  private send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Observable<T> {
    return this.http.request<T>(method, `/api/school${path}`, { body }).pipe(catchError(toMessage));
  }
  private upload<T>(path: string, file: File, fields: Record<string, string> = {}): Observable<T> {
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return this.http.post<T>(`/api/school${path}`, form).pipe(catchError(toMessage));
  }

  // settings & identity
  settings() {
    return this.get<{ settings: SchoolSettings }>('/settings');
  }
  saveSettings(body: Partial<SchoolSettings>) {
    return this.send<{ settings: SchoolSettings }>('PUT', '/settings', body);
  }
  me() {
    return this.get<SchoolMe>('/me');
  }
  overview(date?: string) {
    return this.get<Overview>('/overview', { date });
  }
  classes() {
    return this.get<{ classes: ClassInfo[] }>('/classes');
  }

  // students
  students(classKey?: string, q?: string) {
    return this.get<{ students: Student[] }>('/students', { class: classKey, q });
  }
  saveStudent(body: Partial<Student>) {
    return body.id
      ? this.send<{ student: Student }>('PUT', `/students/${body.id}`, body)
      : this.send<{ student: Student }>('POST', '/students', body);
  }
  removeStudent(id: number) {
    return this.send<{ deleted: number }>('DELETE', `/students/${id}`);
  }
  importStudents(file: File) {
    return this.upload<ImportResult>('/students/import', file);
  }

  // attendance
  attendance(classKey: string, date: string) {
    return this.get<AttendanceSheet>('/attendance', { class: classKey, date });
  }
  markAttendance(body: {
    date: string;
    classKey: string;
    marks: { studentId: number; status: AttendanceStatus; arrivedAt?: string | null }[];
  }) {
    return this.send<AttendanceSheet>('PUT', '/attendance', body);
  }
  importAttendance(file: File, date: string) {
    return this.upload<ImportResult>('/attendance/import', file, { date });
  }
  notifyAttendance(body: { date: string; classKey?: string; kinds: ('absent' | 'late')[] }) {
    return this.send<SendResult>('POST', '/attendance/notify', body);
  }
  studentAttendance(id: number, month: string) {
    return this.get<StudentAttendance>(`/attendance/student/${id}`, { month });
  }

  // timetable
  timetable(classKey: string) {
    return this.get<{ classKey: string; entries: TimetableEntry[] }>('/timetable', {
      class: classKey,
    });
  }
  saveTimetable(classKey: string, entries: TimetableEntry[]) {
    return this.send<{ classKey: string; entries: TimetableEntry[] }>('PUT', '/timetable', {
      classKey,
      entries,
    });
  }
  timetableChange(body: {
    classKey: string;
    day: Day;
    period: string;
    status: 'changed' | 'cancelled';
    note: string;
    notify: boolean;
  }) {
    return this.send<SendResult & { entry: TimetableEntry }>('POST', '/timetable/change', body);
  }

  // homework & notices
  homework(classKey?: string) {
    return this.get<{ homework: Homework[] }>('/homework', { class: classKey });
  }
  publishHomework(body: {
    classKey: string;
    subject: string;
    title: string;
    instructions: string;
    dueAt?: string | null;
    mediaId?: string | null;
    sendAt?: string | null;
  }) {
    return this.send<{ homework: Homework }>('POST', '/homework', body);
  }
  removeHomework(id: number) {
    return this.send<{ deleted: number }>('DELETE', `/homework/${id}`);
  }
  notices(kind?: NoticeKind) {
    return this.get<{ notices: Notice[] }>('/notices', { kind });
  }
  publishNotice(body: {
    kind: NoticeKind;
    title: string;
    body: string;
    startsAt?: string | null;
    endsAt?: string | null;
    audience: Audience;
    mediaId?: string | null;
    broadcast: boolean;
    sendAt?: string | null;
  }) {
    return this.send<{ notice: Notice } & Partial<SendResult>>('POST', '/notices', body);
  }
  removeNotice(id: number) {
    return this.send<{ deleted: number }>('DELETE', `/notices/${id}`);
  }
  /** Reuses the channel media store; returns the id to pass as mediaId. */
  uploadMedia(file: File): Observable<{ mediaId: string; url: string }> {
    const form = new FormData();
    form.append('file', file);
    return this.http
      .post<{ mediaId: string; url: string }>('/api/media/upload', form)
      .pipe(catchError(toMessage));
  }

  // broadcast
  broadcast(body: {
    kind: BroadcastKind;
    message: string;
    audience: Audience;
    mediaId?: string | null;
  }) {
    return this.send<SendResult>('POST', '/broadcast', body);
  }

  // fees
  fees(query: { class?: string; status?: string; term?: string } = {}) {
    return this.get<{ fees: Fee[]; totals: FeeTotals }>('/fees', query);
  }
  createFee(body: {
    studentId: number;
    term: string;
    amount: number;
    dueAt: string;
    payLink?: string;
  }) {
    return this.send<{ fee: Fee }>('POST', '/fees', body);
  }
  bulkFees(body: { classKey: string; term: string; amount: number; dueAt: string }) {
    return this.send<{ created: number }>('POST', '/fees/bulk', body);
  }
  markPaid(id: number, body: { method: string; paidAt?: string }) {
    return this.send<{ fee: Fee; receiptSent: boolean }>('PUT', `/fees/${id}/paid`, body);
  }
  remindFees(body: { ids?: number[]; status?: 'pending' | 'overdue' }) {
    return this.send<SendResult>('POST', '/fees/remind', body);
  }

  // results
  results(query: { exam?: string; class?: string } = {}) {
    return this.get<{ results: ExamResult[]; exams: string[] }>('/results', query);
  }
  importResults(file: File, examName: string, classKey: string) {
    return this.upload<ImportResult>('/results/import', file, { examName, classKey });
  }
  dispatchResults(body: { examName: string; classKey?: string }) {
    return this.send<SendResult>('POST', '/results/dispatch', body);
  }

  // leave
  leave(status?: LeaveRequest['status']) {
    return this.get<{ requests: LeaveRequest[] }>('/leave', { status });
  }
  decideLeave(ticketId: number, body: { decision: 'approve' | 'reject'; note?: string }) {
    return this.send<{ request: LeaveRequest; notified: boolean }>(
      'POST',
      `/leave/${ticketId}/decision`,
      body,
    );
  }

  // PTM
  ptmSlots() {
    return this.get<{ slots: PtmSlot[] }>('/ptm/slots');
  }
  createPtmSlots(body: {
    startsAt: string;
    durationMinutes: number;
    teacher: string;
    classKey: string;
    count: number;
  }) {
    return this.send<{ slots: PtmSlot[] }>('POST', '/ptm/slots', body);
  }
  removePtmSlot(id: number) {
    return this.send<{ deleted: number }>('DELETE', `/ptm/slots/${id}`);
  }

  // staff
  staff() {
    return this.get<{ users: StaffMember[] }>('/staff');
  }
  saveStaff(userId: number, body: { title: StaffTitle; classes: string[] }) {
    return this.send<{ user: StaffMember }>('PUT', `/staff/${userId}`, body);
  }
}

function toMessage(error: HttpErrorResponse) {
  const body = error.error as { errors?: string[] } | null;
  return throwError(() => new Error(body?.errors?.join(' ') || error.message || 'Request failed'));
}
