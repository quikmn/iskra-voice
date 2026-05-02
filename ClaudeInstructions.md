# Origin Voice Client & Server Architecture

## 1. Project Overview
Origin is a high-performance, low-latency voice communication application designed as a modern spiritual successor to Ventrilo. It uses a hybrid architecture:
*   **Server:** A lightweight, headless C# WebSocket server for WebRTC signaling and channel state management.
*   **Client (Wrapper):** A native C# Windows application using WebView2. It handles low-level OS hooks (Global PTT) and secure hardware initialization.
*   **Client (UI):** A web-based frontend (HTML/JS/CSS) running inside the WebView2 wrapper. It handles the UI, WebRTC peer connections, and audio hardware mixing.

---

## 2. Core Philosophy & Engineering Standards
You are operating as a Senior Full-Stack Engineer. Adhere to these strict protocols:

### A. The "No Magic" Rule
*   Do not use complex abstractions or over-engineered design patterns unless absolutely necessary for performance.
*   Prefer explicit state management over implicit "magic" reactivity.

### B. Separation of Concerns (The "Air Gap")
*   **C# owns the OS:** C# handles WebSocket signaling, Global Key Hooks (GetAsyncKeyState), and File I/O (saving settings). C# NEVER touches the audio streams directly.
*   **Javascript owns the Hardware & Audio:** The browser engine handles `getUserMedia`, the `AudioContext`, and the WebRTC `RTCPeerConnection`.
*   **The Bridge:** C# and JS communicate exclusively via `window.chrome.webview.postMessage`. This data must always be strictly typed JSON.

### C. The "Hardware First" Architecture
*   The application must query and lock onto the audio hardware (Mic/Speakers) the moment the `INIT_CLIENT` handshake completes.
*   Do not wait for a user to join a channel to start the audio engine.
*   Local volume meters must reflect raw hardware input/output regardless of network state.

### D. Code Quality & Formatting
*   Do not hallucinate external libraries (no React, no Vue, no external CSS frameworks). Use vanilla JS, vanilla CSS, and the native DOM API.
*   When fixing bugs, utilize the **Surgery Protocol**: Provide ONLY the specific block or function that needs changing. Do not regenerate entire files unless explicitly requested or if it is a net-new file.

---

## 3. Current Project State (The "Clean Snapshot")
*We are currently rolling back to the last stable snapshot before introducing PTT and Hardware Calibration.*

**Server (`iskra_server\Program.cs`):**
*   Handles basic WebSocket connections.
*   Maintains a dictionary of `ActiveClients`.
*   Processes `INIT_CLIENT` (Auth), `JOIN_VOICE` (Channel switching), and `WEBRTC_SIGNAL` (Offer/Answer/ICE routing).
*   *Current Issue:* Needs logic to prevent a single user from joining the same channel multiple times and needs cleanup logic on disconnect.

**Client Wrapper (`iskra_client\Program.cs`):**
*   Initializes WebView2.
*   Currently using `http://` or `file:///` which causes Chromium to block `getUserMedia`.
*   *Immediate Goal:* Must be updated to map a secure Virtual Host (`https://origin.app`) to bypass security blocks. Must implement a background polling loop using `GetAsyncKeyState` for a global PTT hook.

**Client UI (`iskra_client\index.html`):**
*   Basic Ventrilo-style layout (Server List left, Channels middle, User Profile bottom).
*   WebRTC logic is present but brittle due to race conditions (sending `JOIN_VOICE` before `getUserMedia` resolves).
*   *Immediate Goal:* Implement a robust "Settings" modal for hardware selection (Mic/Speaker dropdowns), Voice vs. PTT toggle, and visual level meters.

---

## 4. The Immediate Task
Your first task is to provide the required C# and Javascript code to achieve the following, strictly following the philosophies above:
1.  **Secure Context:** Update the C# wrapper to use `https://origin.app` so the microphone API unlocks.
2.  **Hardware Init:** Update the JS to query devices and show local mic levels *before* connecting to a server.
3.  **Race Condition Fix:** Ensure the JS WebRTC logic strictly `awaits` the hardware stream before sending the `JOIN_VOICE` packet to the server.