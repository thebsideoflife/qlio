import React from "react";
import { Navigate, useLocation } from "react-router-dom";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const password = localStorage.getItem("api_password");

  if (!password) {
    // Redirect them to the /signin page, but save the current location they were
    // trying to go to when they were redirected. This allows us to send them
    // along to that page after they login, which is a nicer user experience.
    return <Navigate to="/signin" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

