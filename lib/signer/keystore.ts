import 'server-only';
import { createDecipheriv, pbkdf2Sync, scryptSync } from 'node:crypto';
import { keccak256 as keccak256Hex } from 'js-sha3';

/**
 * Decrypts a standard Ethereum V3 "Web3 Secret Storage" JSON keystore
 * (https://ethereum.org/en/developers/docs/data-structures-and-encoding/web3-secret-storage/).
 * Implemented directly against Node's crypto module (scrypt/pbkdf2 + aes-128-ctr) so no
 * extra signing library is required just for this one step. The MAC is verified before
 * the derived private key is trusted, exactly as the spec requires.
 */
export function decryptV3Keystore(json: string, password: string): `0x${string}` {
  const parsed = JSON.parse(json) as {
    version: number;
    crypto: {
      ciphertext: string;
      cipherparams: { iv: string };
      cipher: string;
      kdf: string;
      kdfparams: Record<string, unknown>;
      mac: string;
    };
  };
  if (parsed.version !== 3) throw new Error('Only V3 keystores are supported');

  const { crypto } = parsed;
  const ciphertext = Buffer.from(crypto.ciphertext, 'hex');
  const iv = Buffer.from(crypto.cipherparams.iv, 'hex');

  let derivedKey: Buffer;
  if (crypto.kdf === 'scrypt') {
    const { n, r, p, dklen, salt } = crypto.kdfparams as {
      n: number;
      r: number;
      p: number;
      dklen: number;
      salt: string;
    };
    derivedKey = scryptSync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'hex'), dklen, {
      N: n,
      r,
      p,
      maxmem: 1024 * 1024 * 1024,
    });
  } else if (crypto.kdf === 'pbkdf2') {
    const { c, dklen, salt, prf } = crypto.kdfparams as { c: number; dklen: number; salt: string; prf: string };
    if (prf !== 'hmac-sha256') throw new Error(`Unsupported PBKDF2 prf: ${prf}`);
    derivedKey = pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(salt, 'hex'), c, dklen, 'sha256');
  } else {
    throw new Error(`Unsupported KDF: ${crypto.kdf}`);
  }

  const macInput = Buffer.concat([derivedKey.subarray(16, 32), ciphertext]);
  const computedMac = keccak256Hex(macInput);
  if (computedMac !== crypto.mac.toLowerCase().replace(/^0x/, '')) {
    throw new Error('Invalid keystore password');
  }

  if (crypto.cipher !== 'aes-128-ctr') throw new Error(`Unsupported cipher: ${crypto.cipher}`);
  const decipher = createDecipheriv('aes-128-ctr', derivedKey.subarray(0, 16), iv);
  const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return `0x${privateKey.toString('hex')}`;
}

const KEY_ENTER_LF = 10; // '\n'
const KEY_ENTER_CR = 13; // '\r'
const KEY_CTRL_C = 3;
const KEY_BACKSPACE = 127;
const KEY_BACKSPACE_ALT = 8;

/** Prompts for a password on stdin with echo disabled. Only works when stdin is a real TTY. */
export async function promptPassword(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${promptText} - stdin is not a TTY (not running interactively). Set SIGNER_KEYSTORE_PASSWORD instead.`,
    );
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');

    let input = '';
    const onData = (chunk: string) => {
      const code = chunk.charCodeAt(0);
      if (code === KEY_ENTER_LF || code === KEY_ENTER_CR) {
        cleanup();
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      if (code === KEY_CTRL_C) {
        cleanup();
        reject(new Error('Password prompt aborted'));
        return;
      }
      if (code === KEY_BACKSPACE || code === KEY_BACKSPACE_ALT) {
        input = input.slice(0, -1);
        return;
      }
      input += chunk;
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    stdin.on('data', onData);
  });
}
