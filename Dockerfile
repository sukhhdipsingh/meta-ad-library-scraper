FROM apify/actor-node:20

COPY package*.json ./

# Production deps only: the actor ships two runtime dependencies (apify, undici)
# and everything else is Node built-ins, which keeps the image small and the
# compute cost — which comes out of our margin — close to nothing.
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed:" \
    && (npm list --omit=dev --all || true)

COPY . ./

CMD npm start --silent
