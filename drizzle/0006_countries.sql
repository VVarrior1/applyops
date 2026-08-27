ALTER TABLE "companies" ADD COLUMN "countries" text[];--> statement-breakpoint
ALTER TABLE "search_prefs" ADD COLUMN "countries" text[] DEFAULT '{"CA","US"}';