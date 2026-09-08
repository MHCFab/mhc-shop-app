# ShopWorks — brief for legal review

Prepared 8 September 2026 for Mad House Customs LLC.
Not legal advice — this document exists to make an attorney's review faster and cheaper
by giving the context up front and naming the specific questions we need answered.

---

## What we are asking for

Two documents are already written, live, and linked from the product's login page:

- Terms of Service — https://shopworks.app/terms (16 sections)
- Privacy Policy — https://shopworks.app/privacy (10 sections)

Both currently carry a banner saying they are pending legal review. That banner comes off
when you tell us they are sound. We are looking for a review of those two documents and
answers to the questions in the last section.

## The business, in short

Mad House Customs LLC is a North Carolina LLC operating as MHC Fab, a miscellaneous metal
fabrication shop in Troutman, NC. It serves commercial construction and, as a
subcontractor, defense work.

Over the past year the owner built ShopWorks, a web application that runs the shop:
quoting, job tracking, raw material inventory, cut planning, employee time clocking, and a
portal where the shop's own customers see their jobs and place orders. It has been in daily
production use at MHC Fab.

We now intend to sell access to ShopWorks to other small fabrication shops as a monthly
subscription. That is what triggers this review. Relevant characteristics:

- **Business to business only.** Customers are shops, not consumers. Expected users are
  shop owners, office staff, and shop-floor employees.
- **Solo operator.** The owner is the sole developer, the support desk, and the person who
  would answer any legal notice.
- **Multi-tenant.** Every shop's data sits in one shared database, separated by
  database-level access rules. Each shop sees only its own rows.
- **We hold our customers' customer data.** A shop using ShopWorks enters its own
  customers' names and contact details, and can invite those customers to log in to a
  portal. So we are a vendor holding data about third parties who never contracted with us.
- **No payment card data touches our systems.** Payments are planned through Stripe.
- **No consumer or sensitive categories.** No health, financial account, biometric, or
  children's data. Employee records are limited to name, email, role and hours worked.

## Facts already written into the documents

| | |
|---|---|
| Contracting entity | Mad House Customs LLC, a North Carolina limited liability company |
| Notices / privacy / security contact | support@mhcfab.com |
| Governing law and venue | North Carolina; Iredell County |
| Support commitment | Monday–Friday, 7am–4pm Eastern |
| Application address | shopworks.app |
| Hosting | Vercel |
| Database, authentication, file storage, transactional email | Supabase |
| Where data physically sits | Amazon Web Services, us-west-2 (Oregon, United States) |
| Payments (planned, not yet built) | Stripe |
| Free trial | 14 days, no card up front |
| After a subscription ends | 30-day export window; data held 90 days, then deleted |
| Liability cap | 12 months of fees paid |
| Technical log retention | 30–90 days |
| Billing record retention | 7 years |
| Notice for material changes | 30 days |

## Two things you should know before you read

**1. The billing terms describe something that does not exist yet.** The Terms describe a
14-day trial, monthly billing in advance, and lock-out-rather-than-delete on non-payment.
None of that is built. It was written now deliberately, so the documents only need reviewing
once rather than twice. If the eventual implementation departs from what is written, we will
change the documents to match.

**2. Nobody has signed up yet.** MHC Fab is the only shop in the system. No outside customer
has agreed to these terms. We would rather fix problems now than after a third party has
relied on them.

## Questions we need answered

**On the Terms**

1. Is the liability cap enforceable as drafted in North Carolina, and is it the right shape
   for a product a shop would run its operations on? If a bug or an outage cost a shop real
   money, where do we actually stand?
2. The support commitment (Mon–Fri, 7am–4pm Eastern) is a promise made by one person. Should
   it be softened, qualified, or is it fine as a stated target?
3. Is there anything missing that a B2B SaaS agreement in this space normally carries —
   acceptable use, suspension rights, uptime language, indemnification, assignment, notice
   of breach of contract?
4. Is a clickwrap acceptance at signup sufficient for these terms to bind, and what should
   the signup screen actually say and record?

**On the Privacy Policy**

5. Our customers' customers end up in our database without ever dealing with us. Does that
   relationship need to be papered differently — a data processing addendum, or specific
   language in the Terms making the shop the controller and us the processor?
6. Do we need to comply with California, Colorado, Virginia, Texas or other state privacy
   laws given we will likely have customers in those states, and if so what has to change?
7. What are our breach notification obligations, to whom, and in what timeframe?
8. Is naming Supabase, Vercel and Stripe as sub-processors sufficient, or do we need a
   maintained list and a change-notification commitment?

**On the business generally**

9. Is an LLC operating a SaaS product alongside a fabrication shop the right structure, or
   should the software sit in a separate entity? The fabrication business owns physical
   equipment and carries the risks that go with a metal shop.
10. What insurance should be in place before the first outside shop's data is in the
    database — technology errors and omissions, cyber liability, or both?
11. Is there anything in taking on defense-adjacent fabrication customers that changes what
    we may store or where it may be hosted?

## Attached / to review

The two documents are public at the URLs above and can be read without an account.
Source files, if a copy is preferred over the live pages: `app/terms/page.tsx`,
`app/privacy/page.tsx`.

Contact for questions: Erik Petersen, support@mhcfab.com
