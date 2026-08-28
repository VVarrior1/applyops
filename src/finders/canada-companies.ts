/**
 * Curated allow-list of Canadian tech employers used to seed `discoverAts`
 * (src/finders/discover.ts).
 *
 * `src/finders/companies.ts` already imports two *derived* sources (v1's
 * hand-kept allow-lists and the OpenJobs dataset), but neither is
 * Canada-aware: OpenJobs is a global company list with no country field, and
 * v1's lists were built for a US-first search. This file exists to close
 * that gap directly — a hand-researched roster of real, named Canadian
 * employers (mostly software, plus the Canadian engineering offices of large
 * global tech, plus the handful of big banks/telcos/energy majors whose
 * digital arms sometimes run a modern ATS) so `discoverAts` has something
 * Canada-specific to probe rather than relying on whatever a global crawl
 * happened to pick up.
 *
 * `domain` is an optional hint — the company's real primary domain, used by
 * `discover.ts` to derive extra slug candidates (a domain-derived slug often
 * succeeds where a name-derived one doesn't, e.g. a legal-entity name that
 * differs from the product brand). It is omitted wherever not confidently
 * known; slug derivation from `name` alone still runs.
 *
 * This list intentionally includes companies that almost certainly do NOT
 * run Greenhouse/Lever/Ashby/Recruitee/SmartRecruiters (most big banks, oil
 * majors, and consultancies use Workday/SuccessFactors/iCIMS instead) —
 * `discoverAts` probing them is a harmless, quiet miss, and the roster is
 * useful groundwork for the day a Workday finder exists. Every name below is
 * a real, currently-or-formerly operating company; none are invented.
 */

export interface CanadaCompanyHint {
  name: string;
  /** Confident primary domain (no protocol/www). Omitted when not confidently known. */
  domain?: string;
}

const C = (name: string, domain?: string): CanadaCompanyHint => ({ name, domain });

export const CANADA_COMPANIES: CanadaCompanyHint[] = [
  // ---------------------------------------------------------------------
  // Calgary
  // ---------------------------------------------------------------------
  C("Benevity", "benevity.com"),
  C("Symend", "symend.com"),
  C("Neo Financial", "neofinancial.com"),
  C("Helcim", "helcim.com"),
  C("Attabotics", "attabotics.com"),
  C("Showpass", "showpass.com"),
  C("Absorb Software", "absorblms.com"),
  C("Enverus", "enverus.com"),
  C("Arcurve", "arcurve.com"),
  C("Critical Mass", "criticalmass.com"),
  C("Shareworks by Morgan Stanley", "shareworks.com"),
  C("Solium"),
  C("Vog App Developers"),
  C("Launchcode"),
  C("Pason Systems", "pason.com"),
  C("Circle Cardiovascular Imaging", "circlecvi.com"),
  C("Athennian", "athennian.com"),
  C("ZayZoon", "zayzoon.com"),
  C("Tiny", "tiny.cloud"),
  C("Kudos", "kudos.com"),
  C("Gooey"),
  C("RS Energy Group"),
  C("Cybera", "cybera.ca"),
  C("MobSquad", "mobsquad.co"),
  C("Sensei Labs"),
  C("Solera Holdings"),
  // Calgary — large employers / energy / finance
  C("Suncor Energy", "suncor.com"),
  C("Imperial Oil", "imperialoil.ca"),
  C("Cenovus Energy", "cenovus.com"),
  C("TC Energy", "tcenergy.com"),
  C("WestJet", "westjet.com"),
  C("ATCO", "atco.com"),
  C("ATB Financial", "atb.com"),
  C("Canadian Western Bank", "cwbank.com"),
  C("Shaw Communications", "shaw.ca"),
  C("Nutrien", "nutrien.com"),
  C("Parkland Corporation", "parkland.ca"),
  C("TransAlta", "transalta.com"),
  C("AltaGas", "altagas.ca"),

  // ---------------------------------------------------------------------
  // Edmonton
  // ---------------------------------------------------------------------
  C("Jobber", "getjobber.com"),
  C("Drivewyze", "drivewyze.com"),
  C("Intuit Edmonton", "intuit.com"),
  C("AltaML", "altaml.com"),
  C("Yardstick"),
  C("Poppy Barley", "poppybarley.com"),
  C("Showbie", "showbie.com"),
  C("BioWare", "bioware.com"),
  C("DrugBank", "drugbank.com"),

  // ---------------------------------------------------------------------
  // Toronto
  // ---------------------------------------------------------------------
  C("Wealthsimple", "wealthsimple.com"),
  C("Clearco", "clearco.com"),
  C("Ada", "ada.cx"),
  C("Cohere", "cohere.com"),
  C("Ritual", "ritual.co"),
  C("KOHO", "koho.ca"),
  C("Borrowell", "borrowell.com"),
  C("FreshBooks", "freshbooks.com"),
  C("League", "league.com"),
  C("Float Financial"),
  C("Vention"),
  C("Properly"),
  C("Tealbook", "tealbook.com"),
  C("Nudge Rewards", "nudgerewards.com"),
  C("PointClickCare", "pointclickcare.com"),
  C("Ceridian", "dayforce.com"),
  C("TouchBistro", "touchbistro.com"),
  C("Top Hat", "tophat.com"),
  C("Wattpad", "wattpad.com"),
  C("ecobee", "ecobee.com"),
  C("Xanadu", "xanadu.ai"),
  C("Loopio", "loopio.com"),
  C("Sensibill", "sensibill.com"),
  C("Rose Rocket", "roserocket.com"),
  C("Tulip Retail", "tulip.com"),
  C("Uberflip", "uberflip.com"),
  C("Achievers", "achievers.com"),
  C("1Password", "1password.com"),
  C("Coinsquare", "coinsquare.com"),
  C("Wave", "waveapps.com"),
  C("theScore", "thescore.com"),
  C("Maple", "maple.ca"),
  C("Vena Solutions", "venasolutions.com"),
  C("Q4 Inc", "q4inc.com"),
  C("Validere", "validere.com"),
  C("Deep Genomics", "deepgenomics.com"),
  C("Layer 6 AI", "layer6.ai"),
  C("Integrate.ai", "integrate.ai"),
  C("BenchSci", "benchsci.com"),
  C("Nymi", "nymi.com"),
  C("Kira Systems", "kirasystems.com"),
  C("Blueprint Software Systems", "blueprintsys.com"),
  C("PartnerStack", "partnerstack.com"),
  C("Hubdoc", "hubdoc.com"),
  C("SnapTravel", "snaptravel.com"),
  C("Financeit", "financeit.ca"),
  C("Real Matters", "realmatters.com"),
  C("Softchoice", "softchoice.com"),
  C("Rangle.io", "rangle.io"),
  C("SecureKey Technologies", "securekey.com"),
  C("Trader Corporation", "trader.ca"),
  C("Points", "points.com"),
  C("Konrad Group"),
  C("Drop"),
  C("Influitive", "influitive.com"),
  C("Bridgit", "gobridgit.com"),
  C("Paytm Labs"),

  // ---------------------------------------------------------------------
  // Vancouver
  // ---------------------------------------------------------------------
  C("Hootsuite", "hootsuite.com"),
  C("Trulioo", "trulioo.com"),
  C("Bench Accounting", "bench.co"),
  C("Clio", "clio.com"),
  C("Dapper Labs", "dapperlabs.com"),
  C("Later", "later.com"),
  C("Thinkific", "thinkific.com"),
  C("Unbounce", "unbounce.com"),
  C("Article", "article.com"),
  C("Klue", "klue.com"),
  C("Visier", "visier.com"),
  C("Copperleaf", "copperleaf.com"),
  C("Galvanize"),
  C("Absolute Software", "absolute.com"),
  C("Mastercard Foundry"),
  C("Semios", "semios.com"),
  C("Tasktop", "tasktop.com"),
  C("Slack", "slack.com"),
  C("Traction on Demand", "tractionondemand.com"),
  C("Global Relay", "globalrelay.com"),
  C("PayByPhone", "paybyphone.com"),
  C("A Thinking Ape", "athinkingape.com"),
  C("East Side Games", "eastsidegames.com"),
  C("Finger Food Studios"),
  C("Sierra Wireless", "sierrawireless.com"),
  C("Terramera", "terramera.com"),
  C("D-Wave Systems", "dwavesys.com"),
  C("General Fusion", "generalfusion.com"),
  C("Kardium", "kardium.com"),
  C("Mogo", "mogo.ca"),
  C("Finn AI", "finn.ai"),
  C("Wishpond Technologies", "wishpond.com"),
  C("Jane Software", "jane.app"),
  C("Certn", "certn.co"),
  C("Clearly", "clearly.ca"),
  C("Bit Stew Systems"),
  C("Kabam", "kabam.com"),
  C("Alida", "alida.com"),

  // ---------------------------------------------------------------------
  // Montreal
  // ---------------------------------------------------------------------
  C("Lightspeed Commerce", "lightspeedhq.com"),
  C("Nuvei", "nuvei.com"),
  C("Sonder", "sonder.com"),
  C("Paper", "paper.co"),
  C("Hopper", "hopper.com"),
  C("AlayaCare", "alayacare.com"),
  C("Coveo", "coveo.com"),
  C("Busbud", "busbud.com"),
  C("Poka", "poka.io"),
  C("Dialogue Health Technologies", "dialogue.co"),
  C("Breather", "breather.com"),
  C("Unito", "unito.io"),
  C("Ubisoft Montreal", "ubisoft.com"),
  C("Behaviour Interactive", "bhvr.com"),
  C("Element AI", "elementai.com"),
  C("Mistplay", "mistplay.com"),
  C("SSENSE", "ssense.com"),
  C("Frank And Oak", "frankandoak.com"),
  C("GSoft", "gsoft.com"),
  C("Mnubo", "mnubo.com"),
  C("Local Logic", "locallogic.co"),
  C("Genetec", "genetec.com"),
  C("CGI", "cgi.com"),
  C("Plusgrade", "plusgrade.com"),
  C("CAE", "cae.com"),
  C("LeddarTech", "leddartech.com"),
  C("Bombardier", "bombardier.com"),
  C("National Bank of Canada", "nbc.ca"),
  C("Beyond the Rack"),

  // ---------------------------------------------------------------------
  // Ottawa
  // ---------------------------------------------------------------------
  C("Kinaxis", "kinaxis.com"),
  C("Shopify", "shopify.com"),
  C("Fullscript", "fullscript.com"),
  C("Rewind", "rewind.com"),
  C("Assent", "assent.com"),
  C("Ross Video", "rossvideo.com"),
  C("Solace", "solace.com"),
  C("Lytica", "lytica.com"),
  C("Klipfolio", "klipfolio.com"),
  C("Mitel Networks", "mitel.com"),
  C("Calian Group", "calian.com"),
  C("March Networks", "marchnetworks.com"),
  C("Signiant", "signiant.com"),
  C("Fusebill", "fusebill.com"),
  C("Pythian", "pythian.com"),
  C("Espial", "espial.com"),
  C("Corel", "corel.com"),
  C("Halogen Software", "halogensoftware.com"),

  // ---------------------------------------------------------------------
  // Waterloo / Kitchener
  // ---------------------------------------------------------------------
  C("ApplyBoard", "applyboard.com"),
  C("Miovision", "miovision.com"),
  C("Vidyard", "vidyard.com"),
  C("D2L", "d2l.com"),
  C("Magnet Forensics", "magnetforensics.com"),
  C("Auvik", "auvik.com"),
  C("Sortable", "sortable.com"),
  C("Bonfire Interactive", "gobonfire.com"),
  C("Faire", "faire.com"),
  C("Sandvine", "sandvine.com"),
  C("Dejero", "dejero.com"),
  C("eSentire", "esentire.com"),
  C("OpenText", "opentext.com"),
  C("BlackBerry", "blackberry.com"),
  C("Arctic Wolf", "arcticwolf.com"),
  C("Christie Digital", "christiedigital.com"),
  C("Igloo Software", "igloosoftware.com"),
  C("North"),
  C("Clearpath Robotics", "clearpathrobotics.com"),
  C("OTTO Motors", "ottomotors.com"),
  C("Encircle", "getencircle.com"),
  C("Axonify", "axonify.com"),
  C("TextNow", "textnow.com"),
  C("Plum", "plum.io"),
  C("Kik Interactive", "kik.com"),

  // ---------------------------------------------------------------------
  // Halifax / Atlantic Canada
  // ---------------------------------------------------------------------
  C("Dash Hudson", "dashhudson.com"),
  C("Proposify", "proposify.com"),
  C("REDspace", "redspace.com"),
  C("Verafin", "verafin.com"),
  C("Kraken Robotics", "krakenrobotics.com"),
  C("Introhive", "introhive.com"),
  C("Radian6"),
  C("Q1 Labs"),
  C("Smart Skin Technologies"),
  C("T4G", "t4g.com"),
  C("Spring Loaded"),
  C("Meetingmax", "meetingmax.com"),
  C("LeadSift", "leadsift.com"),

  // ---------------------------------------------------------------------
  // Canadian offices of large/global tech, and other major Canadian
  // employers (energy, banks, telcos, consultancies) — most run
  // Workday/SuccessFactors rather than the five vendors this repo reads,
  // so these are largely quiet misses today, kept as groundwork.
  // ---------------------------------------------------------------------
  C("Amazon", "amazon.com"),
  C("Google", "google.com"),
  C("Microsoft", "microsoft.com"),
  C("Meta", "meta.com"),
  C("Salesforce", "salesforce.com"),
  C("Snowflake", "snowflake.com"),
  C("Databricks", "databricks.com"),
  C("Stripe", "stripe.com"),
  C("Uber", "uber.com"),
  C("Cloudflare", "cloudflare.com"),
  C("Instacart", "instacart.com"),
  C("DoorDash", "doordash.com"),
  C("Nvidia", "nvidia.com"),
  C("AMD", "amd.com"),
  C("Intel", "intel.com"),
  C("Qualcomm", "qualcomm.com"),
  C("Cisco", "cisco.com"),
  C("Ericsson", "ericsson.com"),
  C("IBM Canada", "ibm.com"),
  C("SAP", "sap.com"),
  C("Autodesk", "autodesk.com"),
  C("Unity Technologies", "unity.com"),
  C("Electronic Arts", "ea.com"),
  C("Ubisoft", "ubisoft.com"),
  C("WB Games Montreal", "wbgames.com"),
  C("Bell", "bell.ca"),
  C("Telus", "telus.com"),
  C("Rogers Communications", "rogers.com"),
  C("RBC", "rbc.com"),
  C("TD Bank", "td.com"),
  C("BMO", "bmo.com"),
  C("Scotiabank", "scotiabank.com"),
  C("CIBC", "cibc.com"),
  C("Manulife", "manulife.com"),
  C("Sun Life", "sunlife.com"),
  C("Intact Financial", "intact.ca"),
  C("Interac", "interac.ca"),
  C("Questrade", "questrade.com"),
  C("Air Canada", "aircanada.com"),
  C("Canadian National Railway", "cn.ca"),
  C("Canadian Pacific Kansas City", "cpkcr.com"),
  C("Loblaw Digital", "loblawdigital.com"),
  C("Canadian Tire", "canadiantire.ca"),
  C("Aritzia", "aritzia.com"),
  C("lululemon", "lululemon.com"),
  C("Thomson Reuters", "thomsonreuters.com"),
  C("Deloitte", "deloitte.com"),
  C("PwC", "pwc.com"),
  C("KPMG", "kpmg.com"),
  C("EY", "ey.com"),
  C("Enbridge", "enbridge.com"),
];
