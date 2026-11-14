import { useLocation, useNavigate } from "react-router-dom";

/** In-app settings links have a previous view; direct links replace themselves with the menu. */
export function useSettingsBack() {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    if (location.state?.settingsBack) navigate(-1);
    else navigate("/settings", { replace: true });
  };
}
