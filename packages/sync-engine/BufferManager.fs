/// Buffer health evaluation. DOM access stays in TypeScript; this module
/// only reasons over the numbers extracted from the video element.
module SyncEngine.BufferManager

type BufferState =
    { AheadSeconds: float
      IsLow: bool }

/// BF-02: a guest whose buffered-ahead falls below the threshold is "low".
let lowThresholdSeconds = 5.0

let evaluate (aheadSeconds: float) (threshold: float) : BufferState =
    { AheadSeconds = aheadSeconds; IsLow = aheadSeconds < threshold }

/// Given the buffered ranges (flattened [start; end; start; end; ...]) and
/// the current position, how many contiguous seconds are buffered ahead?
let bufferedAhead (ranges: float list) (currentTime: float) : float =
    let rec pairs lst =
        match lst with
        | s :: e :: rest -> (s, e) :: pairs rest
        | _ -> []
    pairs ranges
    |> List.tryFind (fun (s, e) -> currentTime >= s - 0.25 && currentTime <= e)
    |> function
       | Some(_, e) -> max 0.0 (e - currentTime)
       | None -> 0.0

/// Health bucket for the host's per-guest indicator (green/yellow/red).
let healthBucket (ahead: float) (isComplete: bool) : string =
    if isComplete then "green"
    elif ahead >= lowThresholdSeconds then "green"
    elif ahead >= 2.0 then "yellow"
    else "red"
