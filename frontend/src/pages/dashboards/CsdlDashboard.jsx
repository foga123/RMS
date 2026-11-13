import React from "react";
import GenericRoleDashboard from "./GenericRoleDashboard";

export default function CsdlDashboard({ roleSlug, ...rest }) {
  return <GenericRoleDashboard roleSlug={roleSlug ?? "csdl"} {...rest} />;
}
