import React from "react";
import GenericRoleDashboard from "./GenericRoleDashboard";

export default function DeptCallerDashboard({ roleSlug, ...rest }) {
  return <GenericRoleDashboard roleSlug={roleSlug ?? "dept-caller"} {...rest} />;
}
