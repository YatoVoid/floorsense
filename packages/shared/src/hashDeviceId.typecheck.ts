// Compile-only assertions (not a runtime test): confirms the HashedDeviceId
// brand actually rejects a raw string. `tsc --noEmit` fails this file (and
// therefore the whole package) if either `@ts-expect-error` line stops
// producing an error -- i.e. if the branding is ever accidentally weakened
// to a bare `string`, this file breaks the build.
import type { HashedDeviceId } from "./hashDeviceId.ts";

function acceptsHashedDeviceId(_id: HashedDeviceId): void {}

// @ts-expect-error -- a raw string must not be assignable to HashedDeviceId
const rawStringAsHashed: HashedDeviceId = "aa:bb:cc:dd:ee:ff";

// @ts-expect-error -- calling with a bare string (not produced by hashDeviceId) must not typecheck
acceptsHashedDeviceId("not-a-real-hash");

void rawStringAsHashed;
void acceptsHashedDeviceId;
