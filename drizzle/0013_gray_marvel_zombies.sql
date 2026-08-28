CREATE TYPE "public"."resume_base_kind" AS ENUM('latex', 'structured');--> statement-breakpoint
CREATE TABLE "resume_bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "resume_base_kind" DEFAULT 'latex' NOT NULL,
	"latex" text,
	"structured" jsonb,
	"transcript_pdf_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resume_bases" ADD CONSTRAINT "resume_bases_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resume_bases_user_created_idx" ON "resume_bases" USING btree ("user_id","created_at");