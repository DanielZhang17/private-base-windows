import { useLayoutEffect } from "react";
import { useNavigate } from "react-router-dom";
import { registerNavigate } from "./navigation.js";

export function RouterNavigation() {
  const navigate = useNavigate();
  useLayoutEffect(() => registerNavigate(navigate), [navigate]);
  return null;
}
