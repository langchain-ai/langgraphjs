import { it } from "vitest";

// TODO(A0.3): enable this suite once the server emits a dedicated
// queue channel (roadmap A0.3). The hook surface
// (`useSubmissionQueue`) and the client-side `queueStore` already
// mirror server-queue updates; the only missing piece is the
// server-driven event that surfaces queued runs to the client.
//
// Until then, this file is kept as a placeholder so the cut-over
// retains an obvious home for the runtime test, and the type-d tests
// in `stream.test-d.ts` guarantee the hook signature stays correct.
it.skip("mirrors server-side queued runs via useSubmissionQueue", () => {
  // intentionally empty — see note above.
});
