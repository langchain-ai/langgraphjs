<script lang="ts">
  import { getStreamContext } from "../../index.js";

  let errorMessage = $state("");

  try {
    getStreamContext();
  } catch (e: any) {
    errorMessage = e.message;
  }
</script>

<div data-testid="orphan-error">{errorMessage}</div>
