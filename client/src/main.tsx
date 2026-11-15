import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@ionnet/iontronic/styles.css";
import { IontronicProvider, Spinner } from "@ionnet/iontronic/react";
import { authController } from "@/controllers/AuthController.ts";
import { useAuth } from "@/hooks/useAuth.ts";
import { Router } from "@/router/Router.tsx";
import { notFound, routes } from "./routes.tsx";

/**
 * Providers (Iontronic: theme, toasts, tooltips), the auth bootstrap, and the router.
 */
function App() {
  const auth = useAuth();

  useEffect(() => {
    authController.init();
  }, []);

  if (!auth.ready) return <Spinner />;
  return <Router routes={routes} notFound={notFound} loading={<Spinner />} guardKey={auth.getVersion()} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IontronicProvider>
      <App />
    </IontronicProvider>
  </StrictMode>,
);
