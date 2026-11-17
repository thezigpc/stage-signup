import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { basePath, ErrorBoundary, OnScreenKeyboard, VenueAnnouncement } from "@bargames/gamekit/client";
import { AdminPage } from "./pages/AdminPage";
import { KjPage } from "./pages/KjPage";
import { PatronPage } from "./pages/PatronPage";
import { TvPage } from "./pages/TvPage";
import { useVenue } from "./useVenue";
import "./index.css";

/**
 * Bar Games: the venue theme everywhere, and the staff's announcement strip on every page.
 * It follows the announcement's "show" (phones, TVs or both): the TV page is marked a
 * shared screen by tableMode. Off a box it renders nothing.
 */
function Venue() {
  return <VenueAnnouncement ctx={useVenue()} />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter basename={basePath()}>
        <Venue />
        <Routes>
          <Route path="/" element={<PatronPage />} />
          <Route path="/tv" element={<TvPage />} />
          <Route path="/kj" element={<KjPage />} />
          <Route path="/admin" element={<AdminPage />} />
          {/* 0.1.0's room links (/join/ABCD, /room/ABCD) land on the signup page. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      {/* Kit 0.10.0: big keys on a box touchscreen (the signup kiosk); hidden on phones and PCs. */}
      <OnScreenKeyboard />
    </ErrorBoundary>
  </React.StrictMode>,
);
