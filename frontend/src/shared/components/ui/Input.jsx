import React, { forwardRef } from "react";

const Input = forwardRef(({ className = "", icon: Icon, error, ...props }, ref) => {
  return (
    <div className="relative w-full">
      {Icon && (
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
          <Icon className="w-5 h-5" />
        </div>
      )}
      <input
        ref={ref}
        className={`w-full min-w-0 px-3 py-2 bg-white border rounded-lg text-[12.5px] text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all duration-200 ${
          Icon ? "pl-11" : ""
        } ${
          error ? "border-red-400 focus:ring-red-500/20 focus:border-red-500" : "border-slate-200 hover:border-slate-300"
        } ${className}`}
        {...props}
      />
      {error && (
        <p className="mt-1.5 text-sm text-red-500 font-medium animate-fade-in">{error}</p>
      )}
    </div>
  );
});

Input.displayName = "Input";

export default Input;
