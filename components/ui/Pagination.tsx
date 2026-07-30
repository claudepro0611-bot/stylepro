"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { type Button, buttonVariants } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n/LanguageContext";

// ─── Installed @coss/pagination primitives ──────────────────────────────────
// NOTE: the shadcn-generated top-level component was named `Pagination`, but
// this codebase already had an unrelated, already-wired-up `Pagination`
// component (see the legacy drop-in further below) at this same file path
// (case-insensitive collision with `pagination.tsx` on Windows). Renamed to
// `PaginationRoot` to free up the `Pagination` name for the legacy API that
// every existing call site in the app already depends on.

export function PaginationRoot({
  className,
  ...props
}: React.ComponentProps<"nav">): React.ReactElement {
  return (
    <nav
      aria-label="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      data-slot="pagination"
      {...props}
    />
  );
}

export function PaginationContent({
  className,
  ...props
}: React.ComponentProps<"ul">): React.ReactElement {
  return (
    <ul
      className={cn("flex flex-row items-center gap-1", className)}
      data-slot="pagination-content"
      {...props}
    />
  );
}

export function PaginationItem({
  ...props
}: React.ComponentProps<"li">): React.ReactElement {
  return <li data-slot="pagination-item" {...props} />;
}

export type PaginationLinkProps = {
  isActive?: boolean;
  size?: React.ComponentProps<typeof Button>["size"];
} & useRender.ComponentProps<"a">;

export function PaginationLink({
  className,
  isActive,
  size = "icon",
  render,
  ...props
}: PaginationLinkProps): React.ReactElement {
  const defaultProps = {
    "aria-current": isActive ? ("page" as const) : undefined,
    className: render
      ? className
      : cn(
          buttonVariants({
            size,
            variant: isActive ? "outline" : "ghost",
          }),
          className,
        ),
    "data-active": isActive,
    "data-slot": "pagination-link",
  };

  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(defaultProps, props),
    render,
  });
}

export function PaginationPrevious({
  className,
  ...props
}: React.ComponentProps<typeof PaginationLink>): React.ReactElement {
  return (
    <PaginationLink
      aria-label="Go to previous page"
      className={cn("max-sm:aspect-square max-sm:p-0", className)}
      size="default"
      {...props}
    >
      <ChevronLeftIcon className="sm:-ms-1" />
      <span className="max-sm:hidden">Previous</span>
    </PaginationLink>
  );
}

export function PaginationNext({
  className,
  ...props
}: React.ComponentProps<typeof PaginationLink>): React.ReactElement {
  return (
    <PaginationLink
      aria-label="Go to next page"
      className={cn("max-sm:aspect-square max-sm:p-0", className)}
      size="default"
      {...props}
    >
      <span className="max-sm:hidden">Next</span>
      <ChevronRightIcon className="sm:-me-1" />
    </PaginationLink>
  );
}

export function PaginationEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn("flex min-w-7 justify-center", className)}
      data-slot="pagination-ellipsis"
      {...props}
    >
      <MoreHorizontalIcon className="size-5 sm:size-4" />
      <span className="sr-only">More pages</span>
    </span>
  );
}

// ─── Legacy drop-in wrapper ──────────────────────────────────────────────────
// Every existing page in the app renders pagination via
// `<Pagination currentPage totalPages totalItems itemsPerPage onPageChange />`.
// Keep that exact API (so none of those call sites need to change) but build
// the markup out of the primitives above instead of raw <button>s.

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  onPageChange: (page: number) => void;
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
  onPageChange,
}: PaginationProps): React.ReactElement | null {
  const { t } = useLanguage();
  if (totalPages <= 1) return null;

  const start = (currentPage - 1) * itemsPerPage + 1;
  const end = Math.min(currentPage * itemsPerPage, totalItems);

  const delta = 2;
  const rangeStart = Math.max(1, currentPage - delta);
  const rangeEnd = Math.min(totalPages, currentPage + delta);
  const pages: number[] = [];
  for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);

  const pageLinkClassName = (active: boolean) =>
    cn(
      "flex h-7 w-7 items-center justify-center rounded text-xs font-medium transition-colors",
      active
        ? "bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100"
        : "border-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800",
    );

  const navButtonClassName =
    "flex h-7 w-7 items-center justify-center rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors";

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 transition-colors duration-200">
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {totalItems > 0
          ? `${start}–${end} / ${totalItems} ${t("common.unitsSuffix")}`
          : t("common.noData")}
      </p>
      <PaginationRoot className="mx-0 w-auto justify-end">
        <PaginationContent className="gap-0.5">
          <PaginationItem>
            <PaginationLink
              aria-label="Previous"
              className={navButtonClassName}
              render={
                <button
                  disabled={currentPage === 1}
                  onClick={() => onPageChange(currentPage - 1)}
                  type="button"
                />
              }
            >
              <ChevronLeftIcon className="h-3.5 w-3.5" />
            </PaginationLink>
          </PaginationItem>

          {rangeStart > 1 && (
            <>
              <PaginationItem>
                <PaginationLink
                  className={pageLinkClassName(currentPage === 1)}
                  isActive={currentPage === 1}
                  render={<button onClick={() => onPageChange(1)} type="button" />}
                >
                  1
                </PaginationLink>
              </PaginationItem>
              {rangeStart > 2 && (
                <PaginationEllipsis className="h-7 w-7 text-gray-300 dark:text-gray-600" />
              )}
            </>
          )}

          {pages.map((p) => (
            <PaginationItem key={p}>
              <PaginationLink
                className={pageLinkClassName(currentPage === p)}
                isActive={currentPage === p}
                render={<button onClick={() => onPageChange(p)} type="button" />}
              >
                {p}
              </PaginationLink>
            </PaginationItem>
          ))}

          {rangeEnd < totalPages && (
            <>
              {rangeEnd < totalPages - 1 && (
                <PaginationEllipsis className="h-7 w-7 text-gray-300 dark:text-gray-600" />
              )}
              <PaginationItem>
                <PaginationLink
                  className={pageLinkClassName(currentPage === totalPages)}
                  isActive={currentPage === totalPages}
                  render={
                    <button onClick={() => onPageChange(totalPages)} type="button" />
                  }
                >
                  {totalPages}
                </PaginationLink>
              </PaginationItem>
            </>
          )}

          <PaginationItem>
            <PaginationLink
              aria-label="Next"
              className={navButtonClassName}
              render={
                <button
                  disabled={currentPage === totalPages}
                  onClick={() => onPageChange(currentPage + 1)}
                  type="button"
                />
              }
            >
              <ChevronRightIcon className="h-3.5 w-3.5" />
            </PaginationLink>
          </PaginationItem>
        </PaginationContent>
      </PaginationRoot>
    </div>
  );
}
