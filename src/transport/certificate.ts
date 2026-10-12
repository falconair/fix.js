// Test support for src/transport: a self-signed certificate made with node:crypto alone. Not exported by the package.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/** A DER element: its tag, its length, then its contents. */
function der(tag: number, contents: Uint8Array): Buffer {
  const length = contents.length;
  const head = length < 0x80 ? [length] : length < 0x100 ? [0x81, length] : [0x82, length >> 8, length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...head]), contents]);
}

const sequence = (...items: Uint8Array[]) => der(0x30, Buffer.concat(items));
const set = (...items: Uint8Array[]) => der(0x31, Buffer.concat(items));
const integer = (bytes: Uint8Array) => der(0x02, bytes);
const utf8 = (text: string) => der(0x0c, Buffer.from(text, 'utf8'));
const octets = (bytes: Uint8Array) => der(0x04, bytes);
const bits = (bytes: Uint8Array) => der(0x03, Buffer.concat([Buffer.from([0]), bytes]));
const explicit = (n: number, item: Uint8Array) => der(0xa0 + n, item);

function oid(text: string): Buffer {
  const [first = 0, second = 0, ...rest] = text.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) groups.unshift((value & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
}

/** UTCTime, YYMMDDHHMMSSZ: fine for years before 2050. */
function time(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return der(0x17, Buffer.from(`${text}Z`, 'latin1'));
}

const ECDSA_WITH_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));
const DAY_MS = 86_400_000;

/**
 * A key and a self-signed certificate (PEM) for 'localhost' and 127.0.0.1, valid from a day ago to a day from now.
 * Its validity is written as UTCTime, which only holds dates before 2050: test support only.
 */
export function selfSignedCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = sequence(set(sequence(oid('2.5.4.3'), utf8('localhost'))));
  const now = Date.now();
  const altNames = sequence(der(0x82, Buffer.from('localhost', 'latin1')), der(0x87, Buffer.from([127, 0, 0, 1])));
  const extensions = explicit(3, sequence(
    sequence(oid('2.5.29.19'), octets(sequence(der(0x01, Buffer.from([0xff]))))),   // basicConstraints: CA
    sequence(oid('2.5.29.17'), octets(altNames)),                                    // subjectAltName
  ));
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x7f) | 0x40;   // a positive INTEGER, its first byte not 0 (DER allows no leading zero byte here)
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),   // version 3
    integer(serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(time(new Date(now - DAY_MS)), time(new Date(now + DAY_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, bits(sign('sha256', tbs, privateKey)));
  const lines = certificate.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}
