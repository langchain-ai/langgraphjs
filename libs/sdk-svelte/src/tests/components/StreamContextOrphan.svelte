<script lang="ts">
  import { getStream } from "../../index.js";

  let errorMessage = $state("");

  try {
    getStream();
  } catch (e: any) {
    errorMessage = e.message;
  }
</script>

<div data-testid="orphan-error">{errorMessage}</div>
