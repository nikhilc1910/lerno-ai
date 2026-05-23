import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
// FOR COMPONENTS
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
