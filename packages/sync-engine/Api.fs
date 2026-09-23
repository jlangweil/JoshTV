/// Flat, primitive-typed entry points for TypeScript callers.
/// Top-level functions compile to plain multi-argument JS functions,
/// so React hooks never have to construct Fable record classes.
module SyncEngine.Api

open SyncEngine

// ---- ClockSync ----

/// samples is a flat array [clientSend; serverTime; clientReceive; ...]
let computeClockOffset (samples: float[]) : float =
    samples
    |> Array.chunkBySize 3
    |> Array.choose (fun c ->
        if Array.length c = 3 then
            Some { ClockSync.ClientSend = c.[0]
                   ClockSync.ServerTime = c.[1]
                   ClockSync.ClientReceive = c.[2] }
        else None)
    |> Array.toList
    |> ClockSync.computeOffset

// ---- SyncEngine ----

let computeExpectedTime (playing: bool) (currentTime: float) (speed: float) (updatedAt: float) (serverNow: float) : float =
    SyncEngine.computeExpectedTime
        { Playing = playing; CurrentTime = currentTime; Speed = speed; UpdatedAt = updatedAt }
        serverNow

let driftSeconds (expected: float) (actual: float) : float =
    SyncEngine.driftSeconds expected actual

let needsCorrection (expected: float) (actual: float) : bool =
    SyncEngine.needsCorrection expected actual

let needsCatchUpPause (expected: float) (actual: float) : bool =
    SyncEngine.needsCatchUpPause expected actual

let caughtUp (expected: float) (actual: float) : bool =
    SyncEngine.caughtUp expected actual

// ---- BufferManager ----

/// ranges is flattened [start; end; start; end; ...] from video.buffered.
let bufferedAhead (ranges: float[]) (currentTime: float) : float =
    BufferManager.bufferedAhead (Array.toList ranges) currentTime

let bufferHealth (aheadSeconds: float) (isComplete: bool) : string =
    BufferManager.healthBucket aheadSeconds isComplete
