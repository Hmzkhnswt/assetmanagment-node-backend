function buildMetadata() {
  return {
    timestamp: new Date().toISOString(),
    version: process.env.API_VERSION || 'v1',
  };
}

function installApiResponseMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);

  res.apiSuccess = (message, data, statusCode = 200) => {
    res.locals.apiMessage = message;
    return res.status(statusCode).json(data);
  };

  res.json = (payload) => {
    if (
      payload &&
      typeof payload === 'object' &&
      payload.status &&
      payload.message &&
      payload.metadata
    ) {
      return originalJson(payload);
    }

    const statusCode = res.statusCode || 200;
    const metadata = buildMetadata();

    if (statusCode >= 400) {
      const message =
        (payload && typeof payload === 'object' && payload.error) ||
        res.locals.apiMessage ||
        'Request failed';
      const errors =
        payload && typeof payload === 'object' && payload.errors
          ? payload.errors
          : undefined;
      return originalJson({
        status: 'error',
        message,
        data: null,
        ...(errors ? { errors } : {}),
        metadata,
      });
    }

    return originalJson({
      status: 'success',
      message: res.locals.apiMessage || 'Request successful',
      data: payload,
      metadata,
    });
  };

  next();
}

module.exports = {
  installApiResponseMiddleware,
};
