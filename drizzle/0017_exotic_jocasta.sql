CREATE TABLE "job_pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"external_key" text NOT NULL,
	"channel" text NOT NULL,
	"company" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"score" integer,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_pings" ADD CONSTRAINT "job_pings_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_pings_user_key_channel_uq" ON "job_pings" USING btree ("user_id","external_key","channel");--> statement-breakpoint
CREATE INDEX "job_pings_user_sent_idx" ON "job_pings" USING btree ("user_id","sent_at");