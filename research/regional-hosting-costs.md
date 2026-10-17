# Regional hosting costs

Pricing checked 2026-10-16. Estimates are USD, before tax, using 730 hours per month, Linux On-Demand `c7i.large`, and one warm GameLift instance in each new location. This is the **planned steady-state configuration**, not a completed deployment or measured bill. The regional rollout encountered provisioning and process-startup failures; temporary diagnostic capacity and cleanup are recorded in [DEPLOYED.md](../infra/DEPLOYED.md). Oregon remains the only playable backend on its existing server, which will also host the global directory and database after cutover. An additional Oregon GameLift worker is not included.

## Planned three new locations at zero players

| Location shown to players | AWS deployment location | Instance / hour | Instance / month | Public IPv4 allowance / month | Budget / month |
| --- | --- | ---: | ---: | ---: | ---: |
| London | `eu-west-2` | $0.13500 | $98.55 | $3.65 | $102.20 |
| Singapore | `ap-southeast-1` | $0.13200 | $96.36 | $3.65 | $100.01 |
| São Paulo | `sa-east-1` | $0.17800 | $129.94 | $3.65 | $133.59 |
| **Three-location total** | | | **$324.85** | **$10.95** | **$335.80** |

These cities are actual supported GameLift remote locations. Available instance allowance is a deployment prerequisite. New York City is excluded at the user's request; no New York quota request or support case was submitted. Enabling its Local Zone group alone does not start compute or create a warm-server charge. [AWS location reference](https://docs.aws.amazon.com/gameliftservers/latest/developerguide/gamelift-regions.html).

Hourly rates come from the [official AWS GameLift price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonGameLift/current/index.json), published `2026-10-13T15:30:44Z`, with On-Demand terms effective `2026-10-01`. Linux SKUs: London `6BV2GJ7JEJ9ANYRF`, Singapore `JMK2AHYYJ3GMKCCV`, São Paulo `HMET2TDXYNFZPZA9`. Each SKU records 50 GB of instance storage; do not add a second 30 GB gp3 volume to each managed worker estimate. AWS includes network bandwidth for GameLift generation-6-and-later instances, including these `c7i.large` On-Demand workers in commercial regions. Traffic billed to the central Oregon EC2, CloudFront or other non-GameLift services remains separate. [AWS instance pricing](https://aws.amazon.com/gamelift/servers/pricing/instance-pricing/).

The IPv4 allowance assumes one public address per managed worker at $0.005/hour. AWS lists GameLift Servers among services using public IPv4 and says service-managed addresses provisioned to an account are charged. Keep this allowance unless billing confirms that these particular fleet addresses are exempt; bandwidth inclusion does not establish an IPv4 fee waiver. [VPC billing applicability](https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html#vpc-pricing), [IPv4 prices](https://aws.amazon.com/vpc/pricing/).

## Existing Oregon baseline

The [deployed configuration](../infra/DEPLOYED.md) remains a `t3.small` with a 30 GiB gp3 volume, one public IPv4 address, CloudFront and S3 backups. Its estimated core monthly baseline is:

| Existing item | Calculation | Monthly estimate |
| --- | --- | ---: |
| Linux `t3.small` | 730 × $0.0208 | $15.18 |
| 30 GiB gp3, baseline performance | 30 × $0.08 | $2.40 |
| Public IPv4 | 730 × $0.005 | $3.65 |
| **Core subtotal** | | **$21.23** |

The instance rate was verified against [AWS's Oregon Linux price feed](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/US%20West%20%28Oregon%29/Linux/index.json), rate code `8UZJBKH62FYWW5EG.JRTCKXETXF.6YS6EN2CT7`. Storage assumes the $0.08/GB-month gp3 tariff and included baseline performance described in [EBS pricing](https://aws.amazon.com/ebs/pricing/).

The existing shared DNS zone costs $0.50/month if attributed entirely to Bolts. S3 backup/release storage, requests and any CloudFront traffic depend on usage; they are not measured by this estimate. There is no newly requested EBS snapshot or regional database. CloudFront pay-as-you-go has no minimum fee. Preserve the existing **$25–$40/month operating allowance**, giving approximately **$360.80–$375.80/month total** with all three new locations warm. [Route 53 prices](https://aws.amazon.com/route53/pricing/), [CloudFront pricing FAQ](https://aws.amazon.com/cloudfront/faqs/).

## Capacity and alternatives

- Keeping one instance ready requires minimum and desired capacity of one and automatic scale-to-zero disabled. With zero players, this still incurs the full warm-instance cost above. An available server process is not an occupied lobby.
- The two-process-per-instance configuration supports two game sessions per worker. A 20% spare-session target may request a second worker when both processes are occupied. With a maximum of two instances in each new location, the three-location worker budget can approach **$671.60/month** if both instances run all month, before the unchanged Oregon baseline. This is a capacity ceiling, not the zero-player estimate.
- If scale-to-zero is selected later, regional compute and released public-IP charges can fall to $0 after idle sessions close and fleet inactivity elapses. Initial provisioning, the idle tail and the first player's cold start remain. AWS states that automatic scale-to-zero resets minimum capacity to zero, so leaving that feature enabled contradicts a persistent warm minimum. [AWS scale-to/from-zero behavior](https://docs.aws.amazon.com/gameliftservers/latest/developerguide/fleets_scale-to-from-zero.html).
- For comparison only, an extra managed Oregon `c7i.large` is $0.114/hour, or $83.22/month plus $3.65 IPv4. Its SKU is `VGZS4FU633X7S6RK`. The hybrid plan avoids that duplicate worker.

Free-tier credits, reservations, Spot pricing, support plans, taxes, temporary rollout overlap and unrelated account resources are excluded. Prices and allowances must be rechecked before expanding capacity.
