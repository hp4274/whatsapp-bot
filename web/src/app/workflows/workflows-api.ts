/**
 * Typed client for /api/workflows, /api/workflow-runs and /api/recipes.
 * Wire contract: server/src/app.js ("workflows" block), server/src/workflows/store.js
 * and server/src/campaigns/routes.js (recipes) - change both together.
 */

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

export type WorkflowStatus = 'draft' | 'active' | 'paused';
export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

export interface Condition { field: string; op: string; value: unknown }

export interface WorkflowStep {
  id: string;
  action: string;
  params: Record<string, unknown>;
  next: string | null;
  onError: string | null;
}

export interface Workflow {
  id: number;
  channelId: number | null;
  name: string;
  status: WorkflowStatus;
  version: number;
  trigger: { type: string; conditions: Condition[] };
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  runId: string;
  workflowId: number;
  workflowVersion: number;
  contactId: number | null;
  status: RunStatus;
  currentStep: string | null;
  resumeAt: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface RunStep {
  id: number;
  stepId: string;
  action: string;
  attempt: number;
  status: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Recipe {
  key: string;
  name: string;
  description: string;
  industry: string;
  trigger: string;
  requires: { objectType: string | null; templates: string[] };
}

export interface InstallResult { workflow: Workflow; templates: string[]; recipe: string }

/** Error with the HTTP status kept, so a 403 (automations disabled) can be told apart. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

@Injectable({ providedIn: 'root' })
export class WorkflowsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<{ workflows: Workflow[] }> {
    return this.http.get<{ workflows: Workflow[] }>('/api/workflows').pipe(catchError(toMessage));
  }
  setStatus(id: number, status: WorkflowStatus): Observable<{ workflow: Workflow }> {
    return this.http.put<{ workflow: Workflow }>(`/api/workflows/${id}`, { status }).pipe(catchError(toMessage));
  }
  remove(id: number): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`/api/workflows/${id}`).pipe(catchError(toMessage));
  }
  runs(id: number): Observable<{ runs: WorkflowRun[] }> {
    return this.http.get<{ runs: WorkflowRun[] }>(`/api/workflows/${id}/runs`).pipe(catchError(toMessage));
  }
  run(runId: string): Observable<{ run: WorkflowRun; steps: RunStep[] }> {
    return this.http.get<{ run: WorkflowRun; steps: RunStep[] }>(`/api/workflow-runs/${encodeURIComponent(runId)}`)
      .pipe(catchError(toMessage));
  }
  retry(runId: string): Observable<{ run: WorkflowRun }> {
    return this.http.post<{ run: WorkflowRun }>(`/api/workflow-runs/${encodeURIComponent(runId)}/retry`, {})
      .pipe(catchError(toMessage));
  }
  recipes(): Observable<{ recipes: Recipe[] }> {
    return this.http.get<{ recipes: Recipe[] }>('/api/recipes').pipe(catchError(toMessage));
  }
  install(key: string, body: { name?: string; status: 'draft' | 'active' }): Observable<InstallResult> {
    return this.http.post<InstallResult>(`/api/recipes/${encodeURIComponent(key)}/install`, body)
      .pipe(catchError(toMessage));
  }
}

function toMessage(error: HttpErrorResponse) {
  const body = error.error as { errors?: string[] } | null;
  const text = error.status === 403 && !body?.errors?.length
    ? 'Automations are not enabled for this workspace.'
    : body?.errors?.join(' ') || error.message || 'Request failed';
  return throwError(() => new ApiError(text, error.status));
}
