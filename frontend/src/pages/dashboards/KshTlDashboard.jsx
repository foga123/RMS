import React from "react";
import GenericRoleDashboard from "./GenericRoleDashboard";

export default function KshTlDashboard({ roleSlug, ...rest }) {
  return <GenericRoleDashboard roleSlug={roleSlug ?? "ksh-tl"} {...rest} />;
}
