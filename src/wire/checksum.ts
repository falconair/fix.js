/** FIX CheckSum (tag 10): the sum of every byte before the CheckSum field, modulo 256, as three digits. */
export function checksum(bytes: Uint8Array): string {
  let sum = 0;
  for (const byte of bytes) sum += byte;
  return String(sum % 256).padStart(3, '0');
}
