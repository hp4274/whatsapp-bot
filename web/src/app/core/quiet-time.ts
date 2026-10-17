/** 125 minutes after midnight -> "02:05". */
export function clockLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** 72 minutes -> "1h 12m". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
