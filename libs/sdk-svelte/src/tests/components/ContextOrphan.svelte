<script lang="ts">
  import { getStream } from "../../index.js";

  let errorMessage = $state<string>("");

  try {
    getStream();
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
</script>

<div data-testid="orphan-error">{errorMessage}</div>
