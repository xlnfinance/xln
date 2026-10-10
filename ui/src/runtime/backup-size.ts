/** A lower bound only: the tower also accounts for its stored envelope/history.
 * Never upload a bundle that cannot fit even by itself, and never infer that
 * fitting this check guarantees the tower will accept or restore it. */
export function requireBackupCapacity(bytes: number, maximum: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(maximum) || maximum <= 0)
    throw new Error('The recovery service did not report a valid storage limit.');
  if (bytes > maximum) throw new Error(`RECOVERY_BACKUP_TOO_LARGE:bytes=${bytes}:max=${maximum}`);
}

export function requireBackupTransportCapacity(bytes: number, maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum <= 0)
    throw new Error('RECOVERY_TRANSPORT_LIMIT_UNAVAILABLE: the recovery service must advertise its upload limit.');
  if (bytes > maximum) throw new Error(`RECOVERY_UPLOAD_TOO_LARGE:bytes=${bytes}:max=${maximum}`);
}
