import { AnimatePresence, motion } from "framer-motion";
import type { PropsWithChildren } from "react";
import { useLocation } from "react-router-dom";

export function MainContent({ children }: PropsWithChildren) {
  const location = useLocation();

  return (
    <main className="main-content">
      <AnimatePresence mode="wait">
        <motion.section
          key={location.pathname}
          className="main-surface"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          {children}
        </motion.section>
      </AnimatePresence>
    </main>
  );
}
