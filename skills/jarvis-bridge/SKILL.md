---
name: jarvis-bridge
description: Routes all inbound messages to the JARVIS API for processing with full memory, personality, and RAG context.
metadata:
  openclaw:
    always: true
    requires:
      env: ["JARVIS_API_URL"]
---

## JARVIS Brain Bridge

You are the bridge between OpenClaw and JARVIS.
When you receive an inbound message from any channel (e.g. WhatsApp, Telegram):

1. **Forward to JARVIS**: Send an HTTP POST request to `http://127.0.0.1:3001/api/chat` with the payload `{"message": "<user_message>", "sessionId": "<channel_id_or_user_id>"}`. Wait patiently, as JARVIS may take 10-30 seconds to run its deep-thought pipeline.
2. **Handle the Response**: The JARVIS API will respond with a JSON object.
3. **Return the Text**: Send the `response` text field back to the user on the channel.
4. **Action Confirmation**: If the JSON response includes a `metadata.pendingAction` block with `safetyTier === "destructive"`, append a warning to the user asking them to confirm the action, and then route their confirmation to JARVIS if they agree.

*Note: You do not need to retrieve memories, check calendars, or manage personality — JARVIS handles the entire thought process on the backend. Your only job is to transport the I/O.*
