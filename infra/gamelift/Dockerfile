# Build the Rust executable against the same glibc as the managed fleet.
# This image is a build tool; GameLift runs the resulting native executables.
FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS go
WORKDIR /src
COPY server/gamelift/go.mod server/gamelift/go.sum ./
RUN go mod download
COPY server/gamelift/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/bolts-host .

FROM public.ecr.aws/amazonlinux/amazonlinux:2023@sha256:18c71e6a20f8b0834b002b6002156a84eea76162d5adea72d2ea8b86800eaf91 AS rust
RUN dnf install -y gcc gcc-c++ make tar gzip xz findutils && dnf clean all
RUN curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain 1.99.0 --no-modify-path
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./server/
COPY server/src ./server/src
COPY server/schema.sql ./server/
COPY src/generated/hitboxData.json src/generated/handCollisionData.json ./src/generated/
RUN cargo build --release --locked --manifest-path server/Cargo.toml

FROM scratch AS release
COPY --from=rust /src/server/target/release/bolts-server /bolts-server
COPY --from=go /out/bolts-host /bolts-host
