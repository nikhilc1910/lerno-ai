import { AnimatedShinyText } from "@/ui/animated-shiny-text";
import { cn } from "@/lib/utils";
const TitleComponent = ({ title }: { title: string }) => {
  return (
    <div
      className={cn(
        "group rounded-full border  text-base text-white transition-all ease-in hover:cursor-pointer  border-white/5 bg-neutral-900 hover:bg-neutral-800"
      )}
    >
      <AnimatedShinyText className="inline-flex items-center justify-center px-4 py-1 transition ease-out  hover:duration-300 hover:text-neutral-400">
        <span>{title}</span>
      </AnimatedShinyText>
    </div>
  );
};
//Making the component

export default TitleComponent;
