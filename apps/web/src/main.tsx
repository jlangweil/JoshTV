import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { installMediaUnlock } from "./lib/sharedVideo";

// The first tap/click anywhere grants the movie's <video> permission to play
// with sound (Safari/iOS require that per element; see lib/sharedVideo.ts).
installMediaUnlock();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
