export interface PasswordChallenge {
  salt: string;
  iterations: 600000;
  bootstrap: boolean;
}

export function validatePasswordChallenge(value: unknown): PasswordChallenge {
  if (
    !value ||
    typeof value !== "object" ||
    !("salt" in value) ||
    typeof value.salt !== "string" ||
    !/^[a-f0-9]{32}$/i.test(value.salt) ||
    !("iterations" in value) ||
    value.iterations !== 600000 ||
    !("bootstrap" in value) ||
    typeof value.bootstrap !== "boolean"
  ) {
    throw new Error("Invalid password challenge. Refresh and try again.");
  }
  return {
    salt: value.salt,
    iterations: value.iterations,
    bootstrap: value.bootstrap,
  };
}

export function validateNewPassword(value: string): void {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new Error("Password must contain 8 to 128 characters");
  }
  const lower = value.toLowerCase();
  const simple = lower.replace(/[^a-z]/g, "");
  const leet = lower
    .replace(/@|4/g, "a")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/\$|5/g, "s")
    .replace(/1/g, "i")
    .replace(/[^a-z]/g, "");
  const common =
    /^(password|passwrd|letmein|welcome|qwerty|admin|administrator|changeme|iloveyou|monkey|dragon|login|test|secret|abc|abcdefgh|asdfghjkl|correcthorsebatterystaple)+$/;
  if (
    common.test(simple) ||
    common.test(leet) ||
    /^[0-9\s!@#$%^&*_.-]+$/.test(value) ||
    /^(.)\1+$/.test(value) ||
    /^(1234567890|123456789|qwertyuiop|abcdefghijkl)/i.test(value)
  ) {
    throw new Error("Choose a less common password");
  }
}

export async function derivePasswordProof(
  password: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const challenge = validatePasswordChallenge(input);
  signal?.throwIfAborted();
  if (!window.crypto?.subtle)
    throw new Error(
      "Secure password verification is unavailable. Use a supported browser over HTTPS.",
    );
  const passwordBytes = new TextEncoder().encode(password);
  const salt = Uint8Array.from(challenge.salt.match(/../g)!, (byte) =>
    parseInt(byte, 16),
  );
  let proofBytes: Uint8Array | undefined;
  try {
    const key = await window.crypto.subtle.importKey(
      "raw",
      passwordBytes,
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    passwordBytes.fill(0);
    signal?.throwIfAborted();
    proofBytes = new Uint8Array(
      await window.crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 },
        key,
        256,
      ),
    );
    // Native derivation is not abortable; discard its output if cancelled.
    signal?.throwIfAborted();
    return Array.from(proofBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } finally {
    passwordBytes.fill(0);
    proofBytes?.fill(0);
    salt.fill(0);
    // JS strings/CryptoKeys cannot be reliably erased. Keep them flow-local;
    // proofs are password-equivalent and must never be cached or persisted.
  }
}
