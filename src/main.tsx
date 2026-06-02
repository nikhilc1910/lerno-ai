import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Route,
  RouterProvider,
} from "react-router-dom";
import { Toaster } from "react-hot-toast";
import PlaceholdersAndVanishInputDemo from "./components/PlaceholdersAndVanishInputDemo.tsx";
import "./App.css";
import LearningPage from "./components/LearningPage.tsx";
import LandingPage from "./components/LandingPage.tsx";
import Login from "./components/LoginPage.tsx";
import SignUp from "./components/Signup.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import OnboardingCinematic from "./components/OnboardingCinematic.tsx";
import { tracker } from "./utils/BehavioralTracker";

// Wrapper to manage telemetry lifecycle
const TelemetryWrapper = ({ children }: { children: React.ReactNode }) => {
  useEffect(() => {
    tracker.start();

    const handleExpired = () => {
      localStorage.removeItem("lerno_access_token");
      if (window.location.pathname !== "/login" && window.location.pathname !== "/signup") {
        window.location.href = "/login";
      }
    };
    window.addEventListener("auth-session-expired", handleExpired);

    return () => {
      tracker.stop();
      window.removeEventListener("auth-session-expired", handleExpired);
    };
  }, []);

  return <>{children}</>;
};

//paths
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route path="/">
      <Route path="" element={<LandingPage />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/chat" element={<PlaceholdersAndVanishInputDemo />} />
      <Route path="/learning" element={<LearningPage />} />
      <Route path="/onboarding" element={<OnboardingCinematic />} />
    </Route>
  )
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* <App /> */}
    <ErrorBoundary>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "#121212",
            color: "#fff",
            border: "1px solid #232323",
          },
          duration: 4000,
        }}
      />
      <TelemetryWrapper>
        <RouterProvider router={router} />
      </TelemetryWrapper>
    </ErrorBoundary>
  </StrictMode>
);
