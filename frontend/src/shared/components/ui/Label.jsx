import React from "react";

const Label = ({ className = "", children, required, ...props }) => {
  return (
    <label
      className={`block text-xs font-semibold text-slate-700 tracking-wide mb-1 ${className}`}
      {...props}
    >
      {children}
      {required && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
};

export default Label;
