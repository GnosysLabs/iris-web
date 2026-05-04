import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X, ChevronLeft } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // No backdrop on mobile — the dialog is fullscreen page-style there,
      // an overlay would just be a wasted black layer behind opaque content.
      "fixed inset-0 z-50 bg-transparent sm:bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // Mobile: full-screen page — fills the viewport, slides in from
        // the right like a native push-navigation, no border, sticky
        // back-arrow header at the top.  Top-anchored + page scroll so
        // the iOS keyboard never hides content.
        // Desktop (sm+): centered modal as before, with backdrop.
        // `content-start` packs the grid rows at the top instead of
        // stretching to fill, so there's no big gap under the title.
        "fixed z-50 grid gap-4 content-start bg-background shadow-lg duration-200 overflow-y-auto",
        "inset-0 max-h-dvh p-4 pt-16",
        "sm:inset-x-auto sm:left-[50%] sm:top-[50%] sm:w-full sm:max-w-lg sm:max-h-[90dvh] sm:inset-y-auto sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:p-6",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        // Slide in from the right on mobile (push-navigation feel)
        "data-[state=open]:slide-in-from-right-4 data-[state=closed]:slide-out-to-right-4",
        "sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:slide-out-to-left-1/2 sm:data-[state=closed]:slide-out-to-top-[48%] sm:data-[state=open]:slide-in-from-left-1/2 sm:data-[state=open]:slide-in-from-top-[48%]",
        className
      )}
      {...props}
    >
      {/* Mobile: native-page back arrow at top-left (sticky so it stays
          visible while the form scrolls).  Desktop: hidden, the corner X
          handles dismissal. */}
      <DialogPrimitive.Close className="sm:hidden fixed top-2 left-2 z-10 flex items-center gap-1 px-2 py-2 -ml-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronLeft className="h-5 w-5" />
        <span className="text-sm">Back</span>
      </DialogPrimitive.Close>
      {children}
      {/* Desktop X — hidden on mobile, the back arrow above takes over. */}
      <DialogPrimitive.Close className="hidden sm:flex absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
