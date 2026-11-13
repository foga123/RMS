import React from "react";
import GenericRoleDashboard from "./GenericRoleDashboard";

export default function KshCoachDashboard({ roleSlug, ...rest }) {
  return <GenericRoleDashboard roleSlug={roleSlug ?? "ksh-coach"} {...rest} />;
}
